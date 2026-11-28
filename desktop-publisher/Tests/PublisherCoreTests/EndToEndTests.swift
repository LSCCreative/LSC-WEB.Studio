import Foundation
import Testing
@testable import PublisherCore

/// Publishes through a real admin server, end to end. Off unless LSC_E2E_BASE is set,
/// and only ever against a scratch server on this Mac (the launch config
/// `portal-api-fakebunny`): it adds and publishes real versions.
///
///   LSC_E2E_BASE=http://localhost:8090  LSC_E2E_USER=…  LSC_E2E_PASS=…
///   LSC_E2E_SHARE=/tmp/lsc-admin-scratch/deliverables
///   LSC_E2E_PROJECT=prj_…  LSC_E2E_VIDEO_ITEM=dlv_…  LSC_E2E_PHOTO_ITEM=dlv_…  LSC_E2E_FOLDER=C2Test
struct E2E {
    let api: APIClient
    let share: URL
    let project: String
    let videoItem: String
    let photoItem: String
    let folder: String
    let user: String
    let pass: String

    static let env = ProcessInfo.processInfo.environment
    static var on: Bool {
        guard let base = env["LSC_E2E_BASE"], let host = URL(string: base)?.host else { return false }
        return ["localhost", "127.0.0.1"].contains(host)
    }

    init() throws {
        func need(_ key: String) throws -> String {
            guard let value = Self.env[key], !value.isEmpty else { throw APIError.refused(status: 0, code: "env", message: "\(key) is unset") }
            return value
        }
        api = APIClient(base: URL(string: try need("LSC_E2E_BASE"))!, cookies: .sharedCookieStorage(forGroupContainerIdentifier: "studio.lsc.publisher.e2e"))
        share = URL(fileURLWithPath: try need("LSC_E2E_SHARE"), isDirectory: true)
        project = try need("LSC_E2E_PROJECT")
        videoItem = try need("LSC_E2E_VIDEO_ITEM")
        photoItem = try need("LSC_E2E_PHOTO_ITEM")
        folder = try need("LSC_E2E_FOLDER")
        user = try need("LSC_E2E_USER")
        pass = try need("LSC_E2E_PASS")
    }
}

final class Steps: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [PublishStep] = []
    func add(_ step: PublishStep) { lock.withLock { seen.append(step) } }
    var all: [PublishStep] { lock.withLock { seen } }
}

@Suite(.enabled(if: E2E.on), .serialized) struct EndToEndTests {
    @Test func signedOutIsSaidAndAWrongPasswordRefused() async throws {
        let e = try E2E()
        #expect(try await e.api.currentUser() == nil)
        await #expect(throws: APIError.signedOut) { _ = try await e.api.liveProjects() }
        await #expect(throws: APIError.wrongPassword) { _ = try await e.api.login(username: e.user, password: e.pass + "-wrong") }
    }

    @Test func aVideoFromTheDesktopIsCopiedAddedSentAndPublished() async throws {
        let e = try E2E()
        _ = try await e.api.login(username: e.user, password: e.pass)
        #expect(try await e.api.currentUser() != nil)
        #expect(try await e.api.liveProjects().contains { $0.id == e.project })

        let s = try Scratch()
        let source = try s.file("Desktop/Widget cut.mp4", bytes: 3 * 1024 * 1024)
        let before = try await e.api.folder(projectId: e.project)
        let n = (before.deliverables.first { $0.id == e.videoItem }?.newest?.n ?? 0) + 1

        let steps = Steps()
        let publisher = Publisher(api: e.api, pollInterval: .seconds(1))
        let outcome = try await publisher.run(
            PublishRequest(source: source, projectId: e.project, itemId: e.videoItem, folder: e.folder, shareRoot: e.share),
            report: steps.add)

        #expect(outcome.versionN == n)
        let copied = try #require(outcome.copiedTo)
        #expect(copied.hasPrefix(e.folder + "/Widget cut"))
        #expect(FileManager.default.fileExists(atPath: SharePaths.localURL(of: copied, shareRoot: e.share).path))
        let after = try await e.api.folder(projectId: e.project)
        let v = try #require(after.deliverables.first { $0.id == e.videoItem }?.newest)
        #expect(v.n == n && v.publishedAt != nil && v.sourcePath == copied)
        #expect(v.bunny?.status == "ready")
        // It went through every step, in order.
        let kinds = steps.all.map { step -> String in
            switch step {
            case .checking: return "checking"
            case .copying: return "copying"
            case .adding: return "adding"
            case .sending: return "sending"
            case .processing: return "processing"
            case .waitingForServer: return "waiting"
            case .publishing: return "publishing"
            }
        }
        var order: [String] = []
        for k in kinds where order.last != k { order.append(k) }
        #expect(order == ["checking", "copying", "adding", "sending", "processing", "publishing"])
        await e.api.logout()
        #expect(try await e.api.currentUser() == nil)
    }

    @Test func aPhotoFolderAlreadyOnTheShareIsNotCopied() async throws {
        let e = try E2E()
        _ = try await e.api.login(username: e.user, password: e.pass)
        let name = "Widget stills \(UUID().uuidString.prefix(6))"
        let folder = SharePaths.localURL(of: "\(e.folder)/\(name)", shareRoot: e.share)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // Real images (the server makes its sizes from them): the scratch share's own stills.
        let stills = try SharePaths.images(in: SharePaths.localURL(of: "\(e.folder)/Stills", shareRoot: e.share)).prefix(3)
        try #require(!stills.isEmpty)
        for still in stills { try FileManager.default.copyItem(at: still, to: folder.appendingPathComponent(still.lastPathComponent)) }

        let publisher = Publisher(api: e.api, pollInterval: .seconds(1))
        let outcome = try await publisher.run(
            PublishRequest(source: folder, projectId: e.project, itemId: e.photoItem, folder: nil, shareRoot: e.share),
            report: { _ in })
        #expect(outcome.copiedTo == nil)
        let after = try await e.api.folder(projectId: e.project)
        let v = try #require(after.deliverables.first { $0.id == e.photoItem }?.newest)
        #expect(v.kind == "photos" && v.publishedAt != nil && v.sourcePath == "\(e.folder)/\(name)")
        await e.api.logout()
    }

    @Test func photosBunnyCantTakeArePublishedFromTheNAS() async throws {
        let e = try E2E()
        _ = try await e.api.login(username: e.user, password: e.pass)
        let s = try Scratch()
        // Not a real image: the server can't make Bunny's sizes from it, so the send fails.
        try s.file("Desktop/Broken stills/one.png", bytes: 64)
        let publisher = Publisher(api: e.api, pollInterval: .seconds(1))
        let outcome = try await publisher.run(
            PublishRequest(source: s.root.appendingPathComponent("Desktop/Broken stills"), projectId: e.project,
                           itemId: e.photoItem, folder: e.folder, shareRoot: e.share),
            report: { _ in })
        #expect(outcome.bunnyProblem != nil)
        let after = try await e.api.folder(projectId: e.project)
        let v = try #require(after.deliverables.first { $0.id == e.photoItem }?.newest)
        #expect(v.n == outcome.versionN && v.publishedAt != nil && v.bunny?.status == "failed")
        if let copied = outcome.copiedTo { try? FileManager.default.removeItem(at: SharePaths.localURL(of: copied, shareRoot: e.share)) }
        await e.api.logout()
    }

    @Test func aDecomposedAccentedNameIsFoundByTheServer() async throws {
        let e = try E2E()
        _ = try await e.api.login(username: e.user, password: e.pass)
        let s = try Scratch()
        let source = try s.file("Desktop/Cafe\u{301} teaser.mp4", bytes: 1024)
        let publisher = Publisher(api: e.api, pollInterval: .seconds(1))
        let outcome = try await publisher.run(
            PublishRequest(source: source, projectId: e.project, itemId: e.videoItem, folder: e.folder, shareRoot: e.share),
            report: { _ in })
        let copied = try #require(outcome.copiedTo)
        // Composed (NFC), byte for byte, as the server was given it.
        #expect(copied.utf8.starts(with: "\(e.folder)/Caf\u{E9} teaser".utf8))
        await e.api.logout()
    }

    @Test func theServersRefusalIsPassedOnWithWhereItGot() async throws {
        let e = try E2E()
        _ = try await e.api.login(username: e.user, password: e.pass)
        let s = try Scratch()
        let source = try s.file("Desktop/cut.mp4")
        let publisher = Publisher(api: e.api, pollInterval: .seconds(1))
        // An item id that isn't the project's: copied, then refused by the server.
        do {
            _ = try await publisher.run(
                PublishRequest(source: source, projectId: e.project, itemId: "dlv_nope", folder: e.folder, shareRoot: e.share),
                report: { _ in })
            Issue.record("expected a refusal")
        } catch let failure as PublishFailure {
            guard case .copied(let path) = failure.reached else { Issue.record("reached \(failure.reached)"); return }
            try? FileManager.default.removeItem(at: SharePaths.localURL(of: path, shareRoot: e.share))
            // The server's 404, not a lost session.
            #expect(failure.reason == APIError.refused(status: 404, code: "not_found", message: "").errorDescription)
            #expect(failure.errorDescription?.contains("nothing was added") == true)
        }
        await e.api.logout()
    }
}
