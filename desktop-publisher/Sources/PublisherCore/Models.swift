import Foundation

// The admin server's replies, as much of them as the publisher reads. Every field the
// server might leave out is optional, so a reply growing a field never breaks this.

public struct ProjectSummary: Decodable, Sendable, Identifiable, Hashable {
    public struct Client: Decodable, Sendable, Hashable {
        public let businessName: String?
        public let contactName: String?
    }
    public let id: String
    public let upid: String?
    public let name: String?
    public let client: Client?
    public let stage: String?

    /// "Acme launch film · Acme Pty Ltd", for a picker.
    public var label: String {
        let title = (name?.isEmpty == false ? name! : upid) ?? id
        let who = client?.businessName?.isEmpty == false ? client?.businessName : client?.contactName
        guard let who, !who.isEmpty else { return title }
        return "\(title) · \(who)"
    }
}

public struct ProjectsReply: Decodable, Sendable {
    public let projects: [ProjectSummary]
    public let next: String?
}

public struct BunnyProgress: Decodable, Sendable, Hashable {
    public let done: Double?
    public let total: Double?

    /// 0...1, or nil when there's nothing to measure yet.
    public var fraction: Double? {
        guard let done, let total, total > 0 else { return nil }
        return min(max(done / total, 0), 1)
    }
}

/// A version's publish to Bunny: GET/POST …/versions/:id/bunny, or the folder's `bunny`.
public struct BunnyView: Decodable, Sendable, Hashable {
    public let status: String
    public let error: String?
    public let sourceChanged: Bool?
    public let progress: BunnyProgress?
    /// True when Bunny itself said no (the server answers 200 for that).
    public let refused: Bool?
}

public struct Version: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let n: Int
    public let stage: String?
    public let sourcePath: String?
    public let fileName: String?
    public let kind: String?
    public let createdAt: String?
    public let publishedAt: String?
    public let bunny: BunnyView?
}

public struct Deliverable: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let stage: String?
    public let notNeededAt: String?
    public let versions: [Version]

    public var newest: Version? { versions.max { $0.n < $1.n } }
    /// What its next version will be called on the client's screen.
    public var stageLabel: String { Deliverable.stageLabel(stage) }

    public static func stageLabel(_ stage: String?) -> String {
        switch stage {
        case "final": return "Final"
        case "draft": return "Draft Cut"
        default: return stage ?? ""
        }
    }
}

public struct InviteView: Decodable, Sendable, Hashable {
    public let state: String?
    public let firstPublish: Bool?
}

public struct FolderReply: Decodable, Sendable {
    public struct Project: Decodable, Sendable {
        public let id: String
        public let name: String?
        public let archivedAt: String?
        public let acceptedAt: String?
    }
    public let project: Project
    public let deliverables: [Deliverable]
    public let invite: InviteView?
    public let bunnyOn: Bool?

    /// The folder the project's newest file on the NAS is in: where its next one goes.
    public var lastFolder: String? {
        deliverables.flatMap(\.versions)
            .sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
            .compactMap { $0.sourcePath.flatMap(SharePaths.folderOf(sourcePath:)) }
            .first
    }
}

public struct LoginReply: Decodable, Sendable {
    public let username: String?
}
