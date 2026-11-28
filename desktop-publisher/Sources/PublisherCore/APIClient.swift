import Foundation

/// Why a call to the admin server didn't go through.
public enum APIError: Error, Equatable, Sendable, LocalizedError {
    /// No session, or it ended: sign in again.
    case signedOut
    /// Too many wrong passwords from this address; wait this long.
    case tooManyAttempts(seconds: Int)
    case wrongPassword
    /// The server's own refusal, in its own words.
    case refused(status: Int, code: String, message: String)
    case unreachable(String)
    case badReply

    public var errorDescription: String? {
        switch self {
        case .signedOut: return "You’re signed out. Sign in again."
        case .tooManyAttempts(let s): return "Too many tries. Wait \(max(1, (s + 59) / 60)) min and try again."
        case .wrongPassword: return "That username or password isn’t right."
        case .refused(_, let code, let message): return message.isEmpty ? "The server refused (\(code))." : message
        case .unreachable(let why): return "The server can’t be reached. \(why)"
        case .badReply: return "The server sent something unexpected."
        }
    }

    /// Worth trying again by itself (the network blinked), as opposed to a refusal.
    public var isTransient: Bool {
        if case .unreachable = self { return true }
        if case .refused(let status, let code, _) = self { return status >= 500 && code != "bunny_not_set_up" }
        return false
    }
}

/// The admin server's `/api`, signed in with the billing account.
///
/// The session is the server's own cookie, kept by URLSession's cookie store for
/// this app; the password goes to `/api/login` once and is never kept. The app holds
/// no Bunny key: Bunny is the server's business.
public final class APIClient: Sendable {
    public let base: URL
    let session: URLSession
    let cookies: HTTPCookieStorage

    public init(base: URL, cookies: HTTPCookieStorage = .shared) {
        self.base = base
        self.cookies = cookies
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = cookies
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 120
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    /// Lets the session go once its requests finish: for a client replaced by another.
    public func invalidate() {
        session.finishTasksAndInvalidate()
    }

    /// Today's date where the studio is, which the folder routes read their stages by.
    public static func today(_ date: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    func url(_ path: String, query: [URLQueryItem]) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.percentEncodedPath = basePath + path
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    struct Refusal: Decodable {
        let error: String?
        let message: String?
        let retryAfterMs: Double?
    }

    func send<Reply: Decodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil,
        as: Reply.Type = Reply.self
    ) async throws -> Reply {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.unreachable((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.badReply }
        if (200..<300).contains(http.statusCode) {
            do { return try JSONDecoder().decode(Reply.self, from: data) } catch { throw APIError.badReply }
        }
        let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
        switch (http.statusCode, refusal?.error) {
        case (401, "invalid_credentials"): throw APIError.wrongPassword
        case (401, _): throw APIError.signedOut
        case (429, _):
            let ms = refusal?.retryAfterMs ?? Double(http.value(forHTTPHeaderField: "Retry-After") ?? "60").map { $0 * 1000 } ?? 60_000
            throw APIError.tooManyAttempts(seconds: Int((ms / 1000).rounded(.up)))
        case (let status, let code):
            // A proxy's error page (the tunnel down) has no JSON: that's the server away.
            if refusal == nil && status >= 500 { throw APIError.unreachable("It answered \(status).") }
            throw APIError.refused(status: status, code: code ?? "http_\(status)", message: refusal?.message ?? "")
        }
    }

    var today: URLQueryItem { URLQueryItem(name: "today", value: APIClient.today()) }

    // ── Signing in ────────────────────────────────────────────────────────

    struct Credentials: Encodable { let username: String; let password: String }

    public func login(username: String, password: String) async throws -> String {
        let reply: LoginReply = try await send("POST", "/api/login", body: Credentials(username: username, password: password))
        return reply.username ?? username
    }

    /// The signed-in username, or nil when there's no session.
    public func currentUser() async throws -> String? {
        do {
            let reply: LoginReply = try await send("GET", "/api/session")
            return reply.username ?? ""
        } catch APIError.signedOut {
            return nil
        }
    }

    struct OK: Decodable {}
    struct Empty: Encodable {}

    public func logout() async {
        _ = try? await send("POST", "/api/logout", as: OK.self)
        for cookie in cookies.cookies(for: base) ?? [] { cookies.deleteCookie(cookie) }
    }

    // ── Projects and their checklists ─────────────────────────────────────

    /// The projects a version can go to: accepted, not archived, not yet complete.
    public func liveProjects() async throws -> [ProjectSummary] {
        var all: [ProjectSummary] = []
        var before: String?
        repeat {
            var query = [URLQueryItem(name: "stage", value: "live"), URLQueryItem(name: "limit", value: "200"), today]
            if let before { query.append(URLQueryItem(name: "before", value: before)) }
            let page: ProjectsReply = try await send("GET", "/api/projects", query: query)
            all += page.projects
            before = page.next
        } while before != nil
        return all
    }

    /// ASCII letters, digits, '-' and '_' as they are; everything else percent-encoded
    /// (`.alphanumerics` would let any Unicode letter through, which a URL path can't hold).
    static let segmentSafe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")

    static func segment(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: segmentSafe) ?? id
    }

    public func folder(projectId: String) async throws -> FolderReply {
        try await send("GET", "/api/projects/\(Self.segment(projectId))", query: [today])
    }

    func versionsPath(_ projectId: String, _ itemId: String) -> String {
        "/api/projects/\(Self.segment(projectId))/deliverables/\(Self.segment(itemId))/versions"
    }

    struct NewVersion: Encodable { let path: String }

    /// Adds the file at `path` (relative to the deliverables share) as the item's next version.
    public func addVersion(projectId: String, itemId: String, path: String) async throws -> FolderReply {
        try await send("POST", versionsPath(projectId, itemId), query: [today], body: NewVersion(path: path))
    }

    /// Asks the server to send the version to Bunny (it holds the keys; the app doesn't).
    public func sendToBunny(projectId: String, itemId: String, versionId: String) async throws -> BunnyView {
        try await send("POST", versionsPath(projectId, itemId) + "/\(Self.segment(versionId))/bunny", body: Empty())
    }

    public func bunnyStatus(projectId: String, itemId: String, versionId: String) async throws -> BunnyView {
        try await send("GET", versionsPath(projectId, itemId) + "/\(Self.segment(versionId))/bunny")
    }

    /// Puts the version in front of the client. Never sends the portal invite: that
    /// asks who it goes to, so it stays in the admin.
    public func publish(projectId: String, itemId: String, versionId: String) async throws -> FolderReply {
        try await send("POST", versionsPath(projectId, itemId) + "/\(Self.segment(versionId))/publish", query: [today], body: Empty())
    }
}
