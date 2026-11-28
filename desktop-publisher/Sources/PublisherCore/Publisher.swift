import Foundation

/// One drop: the file, and the project and checklist item it becomes the next version of.
public struct PublishRequest: Sendable {
    public let source: URL
    public let projectId: String
    public let itemId: String
    /// The project's folder on the share ("Acme/Cuts"), where a file from elsewhere is
    /// copied. Not needed for a file already on the share.
    public let folder: String?
    public let shareRoot: URL

    public init(source: URL, projectId: String, itemId: String, folder: String?, shareRoot: URL) {
        self.source = source
        self.projectId = projectId
        self.itemId = itemId
        self.folder = folder
        self.shareRoot = shareRoot
    }
}

/// Where a publish has got to, for the progress line.
public enum PublishStep: Sendable, Equatable {
    case checking
    case copying(done: Int64, total: Int64)
    case adding
    case sending
    /// Bunny encoding the video, or the server putting the photos up. Nil: not measurable yet.
    case processing(fraction: Double?, photos: Bool)
    /// The server didn't answer a status check; trying again.
    case waitingForServer
    case publishing

    public var label: String {
        switch self {
        case .checking: return "Checking…"
        case .copying(let done, let total):
            let f = ByteCountFormatter()
            return "Copying to the NAS… \(f.string(fromByteCount: done)) of \(f.string(fromByteCount: total))"
        case .adding: return "Adding the version…"
        case .sending: return "Sending to Bunny…"
        case .processing(let fraction, let photos):
            let what = photos ? "Putting the photos on Bunny" : "Bunny is processing the video"
            guard let fraction else { return "\(what)…" }
            return "\(what)… \(Int((fraction * 100).rounded()))%"
        case .waitingForServer: return "The server didn’t answer. Trying again…"
        case .publishing: return "Publishing…"
        }
    }

    /// 0...1 for a bar, or nil for a spinner.
    public var fraction: Double? {
        switch self {
        case .copying(let done, let total): return total > 0 ? Double(done) / Double(total) : nil
        case .processing(let fraction, _): return fraction
        default: return nil
        }
    }
}

public struct PublishOutcome: Sendable, Equatable {
    public let versionN: Int
    public let itemTitle: String
    public let stageLabel: String
    public let fileName: String
    /// Where the file was copied to on the share, when it was.
    public let copiedTo: String?
    /// The project's first publish: the portal invite is the admin's to send.
    public let firstPublish: Bool
    /// Why Bunny couldn't take a photo library, when it couldn't: it was published
    /// anyway and the client sees the photos from the NAS, as the admin's Publish allows.
    public let bunnyProblem: String?

    public init(versionN: Int, itemTitle: String, stageLabel: String, fileName: String,
                copiedTo: String?, firstPublish: Bool, bunnyProblem: String? = nil) {
        self.versionN = versionN
        self.itemTitle = itemTitle
        self.stageLabel = stageLabel
        self.fileName = fileName
        self.copiedTo = copiedTo
        self.firstPublish = firstPublish
        self.bunnyProblem = bunnyProblem
    }
}

/// What stopped a publish, and how far it got, so the message says what's left to do.
public struct PublishFailure: Error, LocalizedError, Sendable {
    public enum Reached: Sendable, Equatable {
        case nothing
        /// The file is on the NAS, but no version was added.
        case copied(String)
        /// The version exists in the admin but isn't with the client.
        case added(Int)
    }
    public let reached: Reached
    public let reason: String

    public var errorDescription: String? {
        switch reached {
        case .nothing: return reason
        case .copied(let path): return "\(reason) The copy is on the NAS at \(path); nothing was added."
        case .added(let n): return "\(reason) v\(n) is added but not published. Finish it from the Deliverables tab."
        }
    }
}

public enum PublishProblem: Error, LocalizedError, Equatable {
    case shareNotMounted(String)
    case noFolder
    case versionNotFound
    case bunnyFailed(String)
    case notPublished

    public var errorDescription: String? {
        switch self {
        case .shareNotMounted(let path):
            return "The NAS share isn’t connected (\(path) isn’t there). Connect to it in Finder and try again."
        case .noFolder: return "Choose the project’s folder on the NAS first."
        case .versionNotFound: return "The server added a version but didn’t list it."
        case .bunnyFailed(let why): return "Bunny couldn’t take it: \(why)"
        case .notPublished: return "The server answered, but the version isn’t published."
        }
    }
}

/// Runs one drop end to end: copy (if needed) → new version → Bunny → publish.
/// Every step is a server route the admin's Deliverables tab uses too, so the server's
/// own checks (archived, not needed, newest only, Bunny ready) all still apply.
public struct Publisher: Sendable {
    public let api: APIClient
    public var pollInterval: Duration
    /// How many status checks in a row may fail before giving up (about 5 min at 5 s).
    public var patience: Int

    public init(api: APIClient, pollInterval: Duration = .seconds(5), patience: Int = 60) {
        self.api = api
        self.pollInterval = pollInterval
        self.patience = patience
    }

    public func run(
        _ request: PublishRequest,
        report: @escaping @Sendable (PublishStep) -> Void
    ) async throws -> PublishOutcome {
        var reached = PublishFailure.Reached.nothing
        do {
            return try await steps(request, reached: &reached, report: report)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            throw PublishFailure(reached: reached, reason: reason)
        }
    }

    func steps(
        _ request: PublishRequest,
        reached: inout PublishFailure.Reached,
        report: @escaping @Sendable (PublishStep) -> Void
    ) async throws -> PublishOutcome {
        report(.checking)
        let kind = try SharePaths.kind(of: request.source)
        let photoFiles: [URL]? = {
            if case .photos = kind { return try? SharePaths.images(in: request.source) }
            return nil
        }()

        // Already on the share: the server reads it where it is.
        var path: String
        var copiedTo: String?
        if let onShare = SharePaths.relativePath(of: request.source, shareRoot: request.shareRoot) {
            if onShare.isEmpty { throw DropProblem.shareRootItself }
            if !onShare.contains("/") { throw DropProblem.atShareRoot }
            path = onShare
        } else {
            guard FileManager.default.fileExists(atPath: request.shareRoot.path) else {
                throw PublishProblem.shareNotMounted(request.shareRoot.path)
            }
            guard let folder = request.folder, SharePaths.isProjectFolder(folder) else { throw PublishProblem.noFolder }
            let destination = SharePaths.localURL(of: folder, shareRoot: request.shareRoot)
            let copied = try await FileCopier.copy(request.source, photos: photoFiles, into: destination) { done, total in
                report(.copying(done: done, total: total))
            }
            path = SharePaths.serverPath(folder + "/" + copied.lastPathComponent)
            copiedTo = path
            reached = .copied(path)
        }

        report(.adding)
        let added = try await api.addVersion(projectId: request.projectId, itemId: request.itemId, path: path)
        guard let item = added.deliverables.first(where: { $0.id == request.itemId }),
              let version = item.versions.filter({ $0.sourcePath.map(SharePaths.serverPath) == path })
                .max(by: { $0.n < $1.n }) ?? item.newest
        else { throw PublishProblem.versionNotFound }
        reached = .added(version.n)
        let firstPublish = added.invite?.firstPublish == true

        var bunnyProblem: String?
        if added.bunnyOn == true {
            bunnyProblem = try await waitForBunny(request, item: item, version: version, report: report)
        }

        report(.publishing)
        let published = try await api.publish(projectId: request.projectId, itemId: item.id, versionId: version.id)
        let now = published.deliverables.first { $0.id == item.id }?.versions.first { $0.id == version.id }
        guard now?.publishedAt != nil else { throw PublishProblem.notPublished }

        return PublishOutcome(
            versionN: version.n, itemTitle: item.title, stageLabel: Deliverable.stageLabel(version.stage ?? item.stage),
            fileName: version.fileName ?? (path as NSString).lastPathComponent, copiedTo: copiedTo, firstPublish: firstPublish,
            bunnyProblem: bunnyProblem)
    }

    /// Sends the version to Bunny and waits until Bunny has all of it. A video Bunny
    /// can't take stops the publish (the server would hold it anyway). A photo library
    /// it can't take goes out from the NAS, as the admin's Publish allows: the answer is
    /// why, for the studio to send it again later. Nil when Bunny has it all.
    func waitForBunny(
        _ request: PublishRequest, item: Deliverable, version: Version,
        report: @escaping @Sendable (PublishStep) -> Void
    ) async throws -> String? {
        let photos = version.kind == "photos"
        report(.sending)
        var view = try await api.sendToBunny(projectId: request.projectId, itemId: item.id, versionId: version.id)
        var misses = 0
        while true {
            if view.refused == true || view.status == "failed" {
                let why = view.error ?? "no reason given."
                if photos { return why }
                throw PublishProblem.bunnyFailed(why)
            }
            if view.status == "ready" { return nil }
            report(.processing(fraction: view.progress?.fraction, photos: photos))
            try await Task.sleep(for: pollInterval)
            do {
                view = try await api.bunnyStatus(projectId: request.projectId, itemId: item.id, versionId: version.id)
                misses = 0
            } catch let error as APIError where error.isTransient {
                misses += 1
                if misses > patience { throw error }
                report(.waitingForServer)
            }
        }
    }
}
