import AppKit
import Foundation
import Observation
import PublisherCore

/// The app's state: who's signed in, the chosen project and item, and the publish
/// under way. Settings live in UserDefaults; the password lives only in the sign-in
/// field until it's sent.
@MainActor
@Observable
final class PublisherModel {
    enum Phase: Equatable { case starting, signedOut, signedIn }

    /// A drop that passed its checks, with everything it will be published to, fixed
    /// at the drop: changing the pickers afterwards can't send it somewhere else.
    struct Pending {
        let source: URL
        let kind: DropKind
        let onShare: Bool
        let projectId: String
        let item: Deliverable
        let destination: String?
        let bunnyOn: Bool

        var nextN: Int { (item.newest?.n ?? 0) + 1 }
    }

    enum Job {
        /// Dropped; reading what it is (a folder on the NAS can take a moment).
        case checking(source: URL)
        /// Checked, waiting for the studio to say Publish.
        case confirming(Pending)
        case running(source: URL, step: PublishStep)
        case done(PublishOutcome)
        case failed(String)
    }

    static let defaultServer = "https://app.lsccreative.studio"

    private let defaults = UserDefaults.standard

    var phase: Phase = .starting
    var username = ""
    var signInError: String?
    var signingIn = false

    var projects: [ProjectSummary] = []
    var loadingProjects = false
    var listError: String?
    var selectedProjectId: String?
    var folder: FolderReply?
    var loadingFolder = false
    var selectedItemId: String?
    /// The selected project's folder on the share, relative to it.
    var destination: String?

    var job: Job?
    private var task: Task<Void, Never>?
    /// Which project read is the latest: an older one finishing late changes nothing.
    @ObservationIgnored private var folderRead = 0
    @ObservationIgnored private var client: APIClient?

    var serverURL: String {
        didSet { defaults.set(serverURL, forKey: "serverURL") }
    }
    var shareRoot: String {
        didSet { defaults.set(shareRoot, forKey: "shareRoot") }
    }

    init() {
        serverURL = defaults.string(forKey: "serverURL") ?? Self.defaultServer
        shareRoot = defaults.string(forKey: "shareRoot") ?? SharePaths.defaultShareRoot
        selectedProjectId = defaults.string(forKey: "lastProjectId")
        Task { await start() }
    }

    var shareURL: URL { URL(fileURLWithPath: shareRoot, isDirectory: true) }
    var shareConnected: Bool { FileManager.default.fileExists(atPath: shareRoot) }

    /// A server address that's https, or http only on this Mac (for testing).
    var serverBase: URL? {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        if scheme == "https" { return url }
        if scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host) { return url }
        return nil
    }

    /// One client (and one URLSession) per server address; a new address closes the old one.
    var api: APIClient? {
        guard let base = serverBase else { return nil }
        if let client, client.base == base { return client }
        client?.invalidate()
        let fresh = APIClient(base: base)
        client = fresh
        return fresh
    }

    /// A publish is under way: nothing else may start.
    var isBusy: Bool {
        switch job {
        case .running, .checking: return true
        default: return false
        }
    }

    /// The pickers stay put from the drop until the publish ends.
    var isLocked: Bool {
        if case .confirming = job { return true }
        return isBusy
    }

    var items: [Deliverable] { (folder?.deliverables ?? []).filter { $0.notNeededAt == nil } }
    var selectedItem: Deliverable? { items.first { $0.id == selectedItemId } }
    var selectedProject: ProjectSummary? { projects.first { $0.id == selectedProjectId } }

    // ── Signing in ────────────────────────────────────────────────────────

    func start() async {
        guard let api else { phase = .signedOut; return }
        do {
            if let user = try await api.currentUser() {
                username = user
                phase = .signedIn
                await loadProjects()
            } else {
                phase = .signedOut
            }
        } catch {
            phase = .signedOut
            signInError = error.localizedDescription
        }
    }

    func signIn(user: String, password: String) async {
        guard let api else {
            signInError = "The server address needs to be https:// (Settings)."
            return
        }
        signingIn = true
        signInError = nil
        defer { signingIn = false }
        do {
            username = try await api.login(username: user, password: password)
            phase = .signedIn
            await loadProjects()
        } catch {
            signInError = error.localizedDescription
        }
    }

    func signOut() async {
        cancel()
        await api?.logout()
        phase = .signedOut
        projects = []
        folder = nil
        job = nil
    }

    /// Any call that finds the session gone sends the app back to sign-in.
    private func handle(_ error: Error) -> String {
        if case APIError.signedOut = error {
            phase = .signedOut
            signInError = "Your session ended. Sign in again."
        }
        return error.localizedDescription
    }

    // ── Choosing where it goes ────────────────────────────────────────────

    func loadProjects() async {
        guard let api else { return }
        loadingProjects = true
        listError = nil
        defer { loadingProjects = false }
        do {
            projects = try await api.liveProjects()
            let keep = selectedProjectId.flatMap { id in projects.contains { $0.id == id } ? id : nil }
            await selectProject(keep)
        } catch {
            listError = handle(error)
        }
    }

    func selectProject(_ id: String?) async {
        folderRead += 1
        let read = folderRead
        let wasItem = selectedProjectId == id ? selectedItemId : nil
        selectedProjectId = id
        defaults.set(id, forKey: "lastProjectId")
        folder = nil
        destination = nil
        selectedItemId = nil
        guard let id, let api else { loadingFolder = false; return }
        loadingFolder = true
        defer { if read == folderRead { loadingFolder = false } }
        do {
            let reply = try await api.folder(projectId: id)
            guard read == folderRead else { return }
            listError = nil
            folder = reply
            destination = defaults.string(forKey: "folder.\(id)") ?? reply.lastFolder
            let remembered = wasItem ?? defaults.string(forKey: "item.\(id)")
            selectedItemId = items.first { $0.id == remembered }?.id ?? items.first?.id
        } catch {
            guard read == folderRead else { return }
            listError = handle(error)
        }
    }

    func selectItem(_ id: String?) {
        selectedItemId = id
        if let project = selectedProjectId { defaults.set(id, forKey: "item.\(project)") }
    }

    func chooseDestination() {
        guard let project = selectedProjectId, !isLocked else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose this project’s folder on the NAS share. New files are copied into it."
        panel.directoryURL = destination.map { SharePaths.localURL(of: $0, shareRoot: shareURL) } ?? shareURL
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let relative = SharePaths.relativePath(of: url, shareRoot: shareURL)
        guard SharePaths.isProjectFolder(relative), let relative else {
            job = .failed(relative == nil
                ? "That folder isn’t on the NAS share (\(shareRoot))."
                : "That’s the top of the share. Choose a project’s folder inside it.")
            return
        }
        destination = relative
        defaults.set(relative, forKey: "folder.\(project)")
    }

    func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Publish"
        panel.message = "Choose a video, or a folder of photos."
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        drop([url])
    }

    // ── Publishing ────────────────────────────────────────────────────────

    /// What a drop is, and whether it's already on the share, or why it can't go.
    /// Off the main thread: listing a photo folder on the NAS can take a while.
    nonisolated static func check(
        _ url: URL, shareURL: URL, destination: String?
    ) throws -> (DropKind, onShare: Bool) {
        let kind = try SharePaths.kind(of: url)
        let onShare = SharePaths.relativePath(of: url, shareRoot: shareURL)
        if onShare == "" { throw DropProblem.shareRootItself }
        if let onShare, !onShare.contains("/") { throw DropProblem.atShareRoot }
        if onShare == nil {
            if !FileManager.default.fileExists(atPath: shareURL.path) { throw PublishProblem.shareNotMounted(shareURL.path) }
            if !SharePaths.isProjectFolder(destination) { throw PublishProblem.noFolder }
        }
        return (kind, onShare != nil)
    }

    /// A drop: checked, then held for the studio to confirm, fixed to the project,
    /// deliverable and folder chosen now.
    @discardableResult
    func drop(_ urls: [URL]) -> Bool {
        guard !isBusy else { return false }
        guard urls.count == 1, let url = urls.first, url.isFileURL else {
            job = .failed("Drop one file or one photo folder at a time.")
            return false
        }
        guard let projectId = selectedProjectId, let item = selectedItem else {
            job = .failed("Choose the project and the deliverable first.")
            return false
        }
        let destination = destination
        let shareURL = shareURL
        let bunnyOn = folder?.bunnyOn == true
        job = .checking(source: url)
        Task {
            let checked = await Task.detached {
                Result { try Self.check(url, shareURL: shareURL, destination: destination) }
            }.value
            // Stopped, or another drop, meanwhile.
            guard case .checking(let source) = job, source == url else { return }
            switch checked {
            case .success(let (kind, onShare)):
                job = .confirming(Pending(
                    source: url, kind: kind, onShare: onShare, projectId: projectId, item: item,
                    destination: destination, bunnyOn: bunnyOn))
            case .failure(let error):
                job = .failed(error.localizedDescription)
            }
        }
        return true
    }

    func confirm() {
        guard case .confirming(let pending) = job, let api else { return }
        let request = PublishRequest(
            source: pending.source, projectId: pending.projectId, itemId: pending.item.id,
            folder: pending.destination, shareRoot: shareURL)
        let source = pending.source
        job = .running(source: source, step: .checking)
        let publisher = Publisher(api: api)
        // Steps arrive from background threads; each is shown on the main actor.
        let report: @Sendable (PublishStep) -> Void = { [weak self] step in
            guard let model = self else { return }
            Task { @MainActor in model.show(step, for: source) }
        }
        // A main-actor task: the publish itself awaits off the main thread.
        task = Task { @MainActor [weak self] in
            let end: Job
            do {
                let outcome = try await publisher.run(request, report: report)
                end = .done(outcome)
            } catch is CancellationError {
                end = .failed("Stopped. Anything added so far is on the Deliverables tab.")
            } catch {
                if let failure = error as? PublishFailure, failure.reason == APIError.signedOut.errorDescription {
                    self?.phase = .signedOut
                    self?.signInError = "Your session ended. Sign in again."
                }
                end = .failed(error.localizedDescription)
            }
            self?.finish(end)
        }
    }

    /// A progress step, unless the publish has already ended (steps can arrive late).
    private func show(_ step: PublishStep, for source: URL) {
        guard case .running = job else { return }
        job = .running(source: source, step: step)
    }

    private func finish(_ end: Job) {
        job = end
        task = nil
        // The checklist moved on (a new version, published): read it again.
        if phase == .signedIn, let id = selectedProjectId { Task { await selectProject(id) } }
    }

    func cancel() {
        switch job {
        case .confirming, .checking: job = nil
        default: task?.cancel()
        }
    }

    func dismiss() {
        if !isBusy { job = nil }
    }

    /// Quitting mid-publish asks first, then stops it cleanly (a copy in progress is
    /// removed from the NAS) before the app goes.
    func quit() {
        guard case .running = job, let running = task else {
            NSApp.terminate(nil)
            return
        }
        let alert = NSAlert()
        alert.messageText = "A publish is still running."
        alert.informativeText = "Quitting stops it. A copy in progress is removed from the NAS; anything already added stays on the Deliverables tab."
        alert.addButton(withTitle: "Keep Publishing")
        alert.addButton(withTitle: "Stop and Quit")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        running.cancel()
        Task {
            await running.value
            NSApp.terminate(nil)
        }
    }
}
