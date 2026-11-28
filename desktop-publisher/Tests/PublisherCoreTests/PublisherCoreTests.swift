import Foundation
import Testing
@testable import PublisherCore

/// A throwaway folder per test, removed after.
final class Scratch {
    let root: URL
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lscpub-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: root) }

    @discardableResult
    func file(_ path: String, bytes: Int = 10) throws -> URL {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 7, count: bytes).write(to: url)
        return url
    }

    @discardableResult
    func folder(_ path: String) throws -> URL {
        let url = root.appendingPathComponent(path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func names(in path: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(path).path).sorted()
    }
}

@Suite struct SharePathsTests {
    @Test func pathsUnderTheShareAreRelative() throws {
        let s = try Scratch()
        let share = try s.folder("share")
        let file = try s.file("share/Acme/Cuts/v2.mp4")
        #expect(SharePaths.relativePath(of: file, shareRoot: share) == "Acme/Cuts/v2.mp4")
        #expect(SharePaths.relativePath(of: share, shareRoot: share) == "")
        // A trailing slash on the setting changes nothing.
        #expect(SharePaths.relativePath(of: file, shareRoot: URL(fileURLWithPath: share.path + "/")) == "Acme/Cuts/v2.mp4")
    }

    @Test func pathsElsewhereAreNotOnTheShare() throws {
        let s = try Scratch()
        let share = try s.folder("share")
        let outside = try s.file("Desktop/cut.mp4")
        let lookalike = try s.file("share-old/Acme/cut.mp4")
        #expect(SharePaths.relativePath(of: outside, shareRoot: share) == nil)
        #expect(SharePaths.relativePath(of: lookalike, shareRoot: share) == nil)
    }

    @Test func nextFileGoesBesideTheLastOne() {
        #expect(SharePaths.folderOf(sourcePath: "Acme/Cuts/v2.mp4") == "Acme/Cuts")
        #expect(SharePaths.folderOf(sourcePath: "Acme/Stills") == "Acme")
        #expect(SharePaths.folderOf(sourcePath: "loose.mp4") == nil)
    }

    @Test func onlyFoldersBelowTheTopAreProjectFolders() {
        #expect(SharePaths.isProjectFolder("Acme"))
        #expect(SharePaths.isProjectFolder("Acme/Cuts"))
        #expect(!SharePaths.isProjectFolder(""))
        #expect(!SharePaths.isProjectFolder(nil))
        #expect(!SharePaths.isProjectFolder("/Acme"))
        #expect(!SharePaths.isProjectFolder("Acme/../Other"))
    }

    @Test func localURLRebuildsThePath() throws {
        let share = URL(fileURLWithPath: "/Volumes/X/Client Deliverables_Media", isDirectory: true)
        #expect(SharePaths.localURL(of: "Acme/Cuts", shareRoot: share).path == "/Volumes/X/Client Deliverables_Media/Acme/Cuts")
    }

    @Test func freeNamesNeverOverwrite() {
        let taken: Set<String> = ["Cut.mp4", "Cut (2).mp4", "Stills"]
        #expect(SharePaths.freeName(for: "New.mp4") { taken.contains($0) } == "New.mp4")
        #expect(SharePaths.freeName(for: "Cut.mp4") { taken.contains($0) } == "Cut (3).mp4")
        #expect(SharePaths.freeName(for: "Stills", isDirectory: true) { taken.contains($0) } == "Stills (2)")
        // A folder's dot isn't an extension.
        let dotted: Set<String> = ["Stills v1.2"]
        #expect(SharePaths.freeName(for: "Stills v1.2", isDirectory: true) { dotted.contains($0) } == "Stills v1.2 (2)")
    }

    @Test func accentedNamesReachTheServerComposed() throws {
        let s = try Scratch()
        let share = try s.folder("share")
        // "Café" with the accent as its own character (NFD), as macOS can hand it over.
        let decomposed = "Cafe\u{301} teaser.mov"
        let file = try s.file("share/Acme/\(decomposed)")
        let relative = try #require(SharePaths.relativePath(of: file, shareRoot: share))
        #expect(relative == "Acme/Caf\u{E9} teaser.mov")
        #expect(Array(relative.utf8) == Array("Acme/Caf\u{E9} teaser.mov".utf8))
        #expect(Array(SharePaths.serverPath("Acme/\(decomposed)").utf8) == Array("Acme/Caf\u{E9} teaser.mov".utf8))
    }

    @Test func kindFollowsTheServersRules() throws {
        let s = try Scratch()
        #expect(try SharePaths.kind(of: s.file("a/cut.MOV")) == .video)
        #expect(throws: DropProblem.notAVideo) { try SharePaths.kind(of: s.file("a/notes.pdf")) }
        try s.file("photos/b.jpg"); try s.file("photos/a.PNG"); try s.file("photos/._a.jpg")
        try s.file("photos/.DS_Store"); try s.file("photos/readme.txt"); try s.file("photos/sub/c.jpg")
        #expect(try SharePaths.kind(of: s.root.appendingPathComponent("photos")) == .photos(count: 2))
        #expect(throws: DropProblem.noImages) { try SharePaths.kind(of: s.folder("empty")) }
        #expect(throws: DropProblem.unreadable) { try SharePaths.kind(of: s.root.appendingPathComponent("gone.mp4")) }
    }

    @Test func imagesComeInTheServersOrder() throws {
        let s = try Scratch()
        for name in ["IMG_10.jpg", "IMG_2.jpg", "img_1.jpg"] { try s.file("p/\(name)") }
        let names = try SharePaths.images(in: s.root.appendingPathComponent("p")).map(\.lastPathComponent)
        #expect(names == ["img_1.jpg", "IMG_2.jpg", "IMG_10.jpg"])
    }

    @Test func tooManyPhotosIsRefused() throws {
        let s = try Scratch()
        for i in 0...SharePaths.maxPhotosPerFolder { try s.file("big/\(i).jpg", bytes: 1) }
        #expect(throws: DropProblem.tooManyImages(SharePaths.maxPhotosPerFolder + 1)) {
            try SharePaths.kind(of: s.root.appendingPathComponent("big"))
        }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(Int64, Int64)] = []
    func add(_ done: Int64, _ total: Int64) { lock.withLock { values.append((done, total)) } }
    var last: (Int64, Int64)? { lock.withLock { values.last } }
    var count: Int { lock.withLock { values.count } }
}

@Suite struct FileCopierTests {
    @Test func copiesAVideoWholeAndReportsBytes() async throws {
        let s = try Scratch()
        let source = try s.file("Desktop/cut.mp4", bytes: FileCopier.chunkSize * 2 + 5)
        let dest = try s.folder("share/Acme")
        let counter = Counter()
        let copied = try await FileCopier.copy(source, into: dest) { counter.add($0, $1) }
        #expect(copied.lastPathComponent == "cut.mp4")
        #expect(try Data(contentsOf: copied) == Data(contentsOf: source))
        #expect(counter.last! == (Int64(FileCopier.chunkSize * 2 + 5), Int64(FileCopier.chunkSize * 2 + 5)))
        #expect(counter.count >= 3)
        #expect(try s.names(in: "share/Acme") == ["cut.mp4"])
    }

    @Test func aTakenNameGetsANumber() async throws {
        let s = try Scratch()
        let source = try s.file("Desktop/cut.mp4")
        try s.file("share/Acme/cut.mp4", bytes: 3)
        let copied = try await FileCopier.copy(source, into: s.root.appendingPathComponent("share/Acme")) { _, _ in }
        #expect(copied.lastPathComponent == "cut (2).mp4")
        // The file already there is left as it was.
        #expect(try Data(contentsOf: s.root.appendingPathComponent("share/Acme/cut.mp4")).count == 3)
    }

    @Test func aPhotoFolderCopiesOnlyItsImages() async throws {
        let s = try Scratch()
        try s.file("Stills/a.jpg"); try s.file("Stills/b.webp"); try s.file("Stills/.DS_Store"); try s.file("Stills/sub/c.jpg")
        let source = s.root.appendingPathComponent("Stills")
        let dest = try s.folder("share/Acme")
        let copied = try await FileCopier.copy(source, photos: try SharePaths.images(in: source), into: dest) { _, _ in }
        #expect(copied.lastPathComponent == "Stills")
        #expect(try s.names(in: "share/Acme/Stills") == ["a.jpg", "b.webp"])
        #expect(try s.names(in: "share/Acme") == ["Stills"])
    }

    @Test func aMissingDestinationIsSaid() async throws {
        let s = try Scratch()
        let source = try s.file("Desktop/cut.mp4")
        await #expect(throws: FileCopier.Problem.destinationMissing) {
            try await FileCopier.copy(source, into: s.root.appendingPathComponent("share/Nope")) { _, _ in }
        }
    }

    @Test func aFailedCopyLeavesNothingBehind() async throws {
        let s = try Scratch()
        try s.file("Stills/a.jpg")
        let source = s.root.appendingPathComponent("Stills")
        let dest = try s.folder("share/Acme")
        // The second photo has gone by the time it's copied.
        let files = [s.root.appendingPathComponent("Stills/a.jpg"), s.root.appendingPathComponent("Stills/gone.jpg")]
        await #expect(throws: (any Error).self) {
            try await FileCopier.copy(source, photos: files, into: dest) { _, _ in }
        }
        #expect(try s.names(in: "share/Acme") == [])
    }

    @Test func abandonedPartialsOlderThanADayAreSwept() throws {
        let s = try Scratch()
        let folder = try s.folder("share/Acme")
        let old = try s.file("share/Acme/.cut.mp4.lscpart")
        try s.file("share/Acme/.fresh.mp4.lscpart")
        try s.file("share/Acme/.hidden-but-not-ours")
        try s.file("share/Acme/kept.mp4")
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-FileCopier.staleAfter - 60)], ofItemAtPath: old.path)
        FileCopier.sweepStalePartials(in: folder)
        #expect(try s.names(in: "share/Acme") == [".fresh.mp4.lscpart", ".hidden-but-not-ours", "kept.mp4"])
    }

    @Test func aStoppedCopyLeavesNothingBehind() async throws {
        let s = try Scratch()
        let source = try s.file("Desktop/big.mp4", bytes: FileCopier.chunkSize * 6)
        let dest = try s.folder("share/Acme")
        let task = Task { try await FileCopier.copy(source, into: dest) { _, _ in } }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(try s.names(in: "share/Acme") == [])
    }
}

@Suite struct RepliesTests {
    static let folderJSON = """
    {"ok":true,"bunnyOn":true,"invite":{"state":"ready","firstPublish":true,"to":"x@example.test"},
     "project":{"id":"prj_1","name":"Launch","archivedAt":null,"acceptedAt":"2026-11-01T00:00:00Z","extra":1},
     "deliverables":[
       {"id":"dlv_a","title":"Hero film","stage":"final","notNeededAt":null,"versions":[
         {"id":"ver_1","n":1,"stage":"draft","sourcePath":"Acme/Cuts/v1.mp4","fileName":"v1.mp4","kind":"video",
          "createdAt":"2026-11-02T00:00:00Z","publishedAt":"2026-11-02T01:00:00Z","bunny":null},
         {"id":"ver_2","n":2,"stage":"final","sourcePath":"Acme/Finals/v2.mp4","fileName":"v2.mp4","kind":"video",
          "createdAt":"2026-11-05T00:00:00Z","publishedAt":null,
          "bunny":{"status":"processing","error":null,"videoId":"g","progress":{"done":40,"total":100}}}]},
       {"id":"dlv_b","title":"Stills","stage":"draft","notNeededAt":"2026-11-03T00:00:00Z","versions":[]}
     ]}
    """

    @Test func aFolderReplyDecodes() throws {
        let folder = try JSONDecoder().decode(FolderReply.self, from: Data(Self.folderJSON.utf8))
        #expect(folder.bunnyOn == true)
        #expect(folder.invite?.firstPublish == true)
        #expect(folder.deliverables.count == 2)
        #expect(folder.deliverables[0].newest?.id == "ver_2")
        #expect(folder.deliverables[0].newest?.bunny?.progress?.fraction == 0.4)
        #expect(folder.deliverables[0].stageLabel == "Final")
        // The next file goes where the newest one went.
        #expect(folder.lastFolder == "Acme/Finals")
    }

    @Test func aProjectLabelNamesTheClient() throws {
        let json = """
        {"projects":[{"id":"p1","upid":"LSC-1","name":"Launch","client":{"businessName":"Acme","contactName":"Sam"},"stage":"accepted"},
                     {"id":"p2","upid":"LSC-2","name":"","client":{"businessName":"","contactName":""}}],"next":null}
        """
        let reply = try JSONDecoder().decode(ProjectsReply.self, from: Data(json.utf8))
        #expect(reply.projects[0].label == "Launch · Acme")
        #expect(reply.projects[1].label == "LSC-2")
    }

    @Test func todayIsTheLocalDate() {
        let sydney = TimeZone(identifier: "Australia/Sydney")!
        // 2026-11-28 14:30 UTC is already the 29th in Sydney.
        let date = Date(timeIntervalSince1970: 1_795_876_200)
        #expect(APIClient.today(date, timeZone: sydney) == "2026-11-29")
        #expect(APIClient.today(date, timeZone: TimeZone(identifier: "UTC")!) == "2026-11-28")
    }

    @Test func urlsKeepTheBasePath() {
        let api = APIClient(base: URL(string: "https://example.test/")!)
        let url = api.url("/api/projects/prj%201", query: [URLQueryItem(name: "today", value: "2026-11-28")])
        #expect(url.absoluteString == "https://example.test/api/projects/prj%201?today=2026-11-28")
        #expect(APIClient.segment("a b/c") == "a%20b%2Fc")
        // Any letter outside ASCII is escaped too, so the URL always builds.
        #expect(APIClient.segment("prj_\u{E9}t\u{E9}") == "prj_%C3%A9t%C3%A9")
        _ = api.url("/api/projects/" + APIClient.segment("prj_\u{E9}"), query: [])
    }
}
