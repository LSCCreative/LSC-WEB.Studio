import Foundation

/// Copies a video or a photo folder onto the NAS share, with progress.
///
/// The copy is written under a hidden `.lscpart` name and renamed into place only
/// once every byte is there, so the server never reads half a file, and a copy that
/// fails or is cancelled leaves nothing behind but is removed. Only file contents
/// are written (no extended attributes), so no `._` files appear beside the photos.
public enum FileCopier {
    public static let chunkSize = 8 * 1024 * 1024

    public enum Problem: Error, LocalizedError, Equatable {
        case destinationMissing
        case failed(String)

        public var errorDescription: String? {
            switch self {
            case .destinationMissing: return "The project’s folder isn’t on the NAS share. Check the share is connected."
            case .failed(let why): return "The copy to the NAS stopped: \(why)"
            }
        }
    }

    static func partialURL(for destination: URL) -> URL {
        destination.deletingLastPathComponent().appendingPathComponent(".\(destination.lastPathComponent).lscpart")
    }

    static func size(of url: URL) -> Int64 {
        Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }

    /// Copies `source` (a video file, or a folder whose images are `files`) into
    /// `folder` under a free name. Returns the final URL. `progress(done, total)` is
    /// called from a background thread as bytes land.
    public static func copy(
        _ source: URL,
        photos files: [URL]? = nil,
        into folder: URL,
        progress: @escaping @Sendable (Int64, Int64) -> Void
    ) async throws -> URL {
        // Off the main thread; a detached task doesn't inherit cancellation, so pass it on.
        let task = Task.detached(priority: .userInitiated) {
            try copySync(source, photos: files, into: folder, progress: progress)
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    static func copySync(
        _ source: URL,
        photos files: [URL]?,
        into folder: URL,
        progress: @escaping @Sendable (Int64, Int64) -> Void
    ) throws -> URL {
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw Problem.destinationMissing
        }
        sweepStalePartials(in: folder)
        let name = SharePaths.freeName(for: source.lastPathComponent, isDirectory: files != nil) { candidate in
            fm.fileExists(atPath: folder.appendingPathComponent(candidate).path)
                || fm.fileExists(atPath: partialURL(for: folder.appendingPathComponent(candidate)).path)
        }
        let destination = folder.appendingPathComponent(name)
        let partial = partialURL(for: destination)
        let pairs: [(URL, URL)]
        if let files {
            pairs = files.map { ($0, partial.appendingPathComponent($0.lastPathComponent)) }
        } else {
            pairs = [(source, partial)]
        }
        let total = pairs.reduce(Int64(0)) { $0 + size(of: $1.0) }
        var done: Int64 = 0
        progress(0, total)
        do {
            if files != nil { try fm.createDirectory(at: partial, withIntermediateDirectories: false) }
            for (from, to) in pairs {
                try copyFile(from, to) { n in
                    done += n
                    progress(done, total)
                }
            }
            try fm.moveItem(at: partial, to: destination)
        } catch {
            try? fm.removeItem(at: partial)
            if error is CancellationError { throw error }
            if let problem = error as? Problem { throw problem }
            throw Problem.failed((error as NSError).localizedDescription)
        }
        return destination
    }

    /// How old a `.lscpart` must be before it's taken as abandoned (the app quit or the
    /// Mac slept mid-copy). A day, so another Mac's copy still going is never touched.
    public static let staleAfter: TimeInterval = 24 * 60 * 60

    /// Removes abandoned partial copies from a folder. Best effort: a failure is ignored.
    static func sweepStalePartials(in folder: URL, now: Date = Date()) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.contentModificationDateKey], options: []) else { return }
        for url in entries {
            let name = url.lastPathComponent
            guard name.hasPrefix("."), name.hasSuffix(".lscpart") else { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? now
            if now.timeIntervalSince(modified) > staleAfter { try? fm.removeItem(at: url) }
        }
    }

    static func copyFile(_ from: URL, _ to: URL, wrote: (Int64) -> Void) throws {
        guard FileManager.default.createFile(atPath: to.path, contents: nil) else {
            throw Problem.failed("Couldn’t create \(to.lastPathComponent) on the share.")
        }
        let input = try FileHandle(forReadingFrom: from)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: to)
        defer { try? output.close() }
        while true {
            try Task.checkCancellation()
            let chunk = try autoreleasepool { try input.read(upToCount: chunkSize) }
            guard let chunk, !chunk.isEmpty else { break }
            try output.write(contentsOf: chunk)
            wrote(Int64(chunk.count))
        }
        try output.synchronize()
    }
}
