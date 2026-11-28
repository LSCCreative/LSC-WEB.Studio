import Foundation

/// What a dropped file or folder is, by the server's own rules
/// (admin/server/src/hub/deliverables.js): a file is a video, a folder a photo library.
public enum DropKind: Equatable, Sendable {
    case video
    case photos(count: Int)
}

/// A drop the server would refuse, in the words the admin uses for the same refusal.
public enum DropProblem: Error, Equatable, Sendable, LocalizedError {
    case unreadable
    case notAVideo
    case noImages
    case tooManyImages(Int)
    case atShareRoot
    case shareRootItself

    public var errorDescription: String? {
        switch self {
        case .unreadable: return "That can’t be read. Check it’s still where it was."
        case .notAVideo: return "That file isn’t a video (.mp4, .mov, .webm or .m4v). For photos, drop the folder they’re in."
        case .noImages: return "That folder has no .jpg, .png or .webp images in it."
        case .tooManyImages(let n): return "That folder has \(n) images (the limit is \(SharePaths.maxPhotosPerFolder)). Drop a single delivery folder."
        case .atShareRoot: return "That’s at the top of the share. It needs to be inside a project’s folder."
        case .shareRootItself: return "That’s the whole deliverables share. Drop one file or one photo folder."
        }
    }
}

/// Where things are on the mounted NAS share, and what the server calls them.
///
/// The server takes a path relative to the deliverables folder ("Project/v3.mp4"),
/// which is the same folder this Mac mounts over SMB. So a file under the mounted
/// folder needs no copy, and anything else is copied into the project's folder there.
public enum SharePaths {
    public static let videoExtensions: Set<String> = ["mp4", "mov", "webm", "m4v"]
    public static let photoExtensions: Set<String> = ["jpg", "jpeg", "png", "webp"]
    public static let maxPhotosPerFolder = 200
    /// Where macOS mounts the NAS's media share, with the deliverables folder inside it.
    public static let defaultShareRoot = "/Volumes/LSC Creative_Media/Client Deliverables_Media"

    /// A path in one Unicode form (NFC). macOS can hand a file's name over decomposed
    /// ("e" + accent), while the NAS and the server's database hold it composed: two
    /// spellings of "Café.mov" whose bytes differ, so the server wouldn't find the file.
    static func canonical(_ url: URL) -> String {
        var path = url.standardizedFileURL.resolvingSymlinksInPath().path
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        return path.precomposedStringWithCanonicalMapping
    }

    /// A relative path as the server should be given it (NFC, see `canonical`).
    public static func serverPath(_ relativePath: String) -> String {
        relativePath.precomposedStringWithCanonicalMapping
    }

    /// The server's path for something under the mounted share, or nil when it's elsewhere.
    /// The share root itself is "" (never a valid version path).
    public static func relativePath(of url: URL, shareRoot: URL) -> String? {
        let root = canonical(shareRoot)
        let path = canonical(url)
        if path == root { return "" }
        guard path.hasPrefix(root + "/") else { return nil }
        return String(path.dropFirst(root.count + 1))
    }

    /// The local URL of a path the server named.
    public static func localURL(of relativePath: String, shareRoot: URL) -> URL {
        relativePath.split(separator: "/").reduce(shareRoot) { $0.appendingPathComponent(String($1)) }
    }

    /// The folder a version's file sits in, which is where the next one goes:
    /// "Acme/Cuts/v2.mp4" → "Acme/Cuts", a photo library "Acme/Stills" → "Acme".
    /// Nil when that would be the top of the share.
    public static func folderOf(sourcePath: String) -> String? {
        let parts = sourcePath.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }

    /// Whether a folder is somewhere a version may live: inside the share, below its top.
    public static func isProjectFolder(_ relativePath: String?) -> Bool {
        guard let relativePath, !relativePath.isEmpty else { return false }
        return !relativePath.hasPrefix("/") && !relativePath.split(separator: "/").contains("..")
    }

    static func isHidden(_ name: String) -> Bool { name.hasPrefix(".") }

    /// The images directly in a folder, in the server's order, skipping hidden files
    /// (macOS's `._` and `.DS_Store`) and subfolders, which the server never reads.
    public static func images(in folder: URL) throws -> [URL] {
        let entries = try FileManager.default.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.isRegularFileKey], options: [])
        return entries
            .filter { url in
                let name = url.lastPathComponent
                guard !isHidden(name), photoExtensions.contains(url.pathExtension.lowercased()) else { return false }
                return (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    /// What a drop is, or why the server would refuse it.
    public static func kind(of url: URL) throws -> DropKind {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw DropProblem.unreadable
        }
        if !isDirectory.boolValue {
            guard videoExtensions.contains(url.pathExtension.lowercased()) else { throw DropProblem.notAVideo }
            return .video
        }
        let found: [URL]
        do { found = try images(in: url) } catch { throw DropProblem.unreadable }
        if found.isEmpty { throw DropProblem.noImages }
        if found.count > maxPhotosPerFolder { throw DropProblem.tooManyImages(found.count) }
        return .photos(count: found.count)
    }

    /// A name not yet taken in a folder: "Cut.mp4", then "Cut (2).mp4", "Cut (3).mp4"…
    /// A folder has no extension, so "Stills v1.2" becomes "Stills v1.2 (2)".
    /// A version never overwrites a file on the NAS, since an earlier version may be it.
    public static func freeName(for name: String, isDirectory: Bool = false, taken: (String) -> Bool) -> String {
        if !taken(name) { return name }
        let ext = isDirectory ? "" : (name as NSString).pathExtension
        let stem = isDirectory ? name : (name as NSString).deletingPathExtension
        var n = 2
        while true {
            let candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            if !taken(candidate) { return candidate }
            n += 1
        }
    }
}
