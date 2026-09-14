import Foundation
import InfinMonkeyCore
import SwiftUI
import UniformTypeIdentifiers

/// The app's view model: observable state plus calls into the Core library.
///
/// It holds no storage logic of its own — every operation forwards to
/// `LibraryService`, which is where the testable behavior lives. Refreshes
/// re-read the store because the extension is a separate process and may have
/// changed anything while this window was inactive.
@Observable
@MainActor
final class StoreModel {
  private(set) var summaries: [EntrySummary] = []
  private(set) var rev = 0
  var lastError: String?
  private(set) var storagePath = ""

  var importPresented = false
  var exportPresented = false

  private let library: LibraryService

  init(library: LibraryService? = nil) {
    let service = library ?? Self.makeDefaultLibrary()
    self.library = service
    self.storagePath = service.storagePath
    if let error = service.locationError {
      self.lastError = error
    }
  }

  private static func makeDefaultLibrary() -> LibraryService {
    do {
      return LibraryService(layout: try StoreLocation.layout())
    } catch {
      // A missing app group key is a build fault; surface it instead of
      // silently writing into a per-process container.
      return LibraryService.unavailable(error: "\(error)")
    }
  }

  // MARK: - Queries

  func refresh() async {
    do {
      let snapshot = try await library.summaries()
      summaries = snapshot.entries
      rev = snapshot.rev
      lastError = nil
    } catch {
      lastError = Self.describe(error)
    }
  }

  func summary(id: String) -> EntrySummary? {
    summaries.first { $0.id == id }
  }

  func loadEntry(id: String) async -> FullEntry? {
    do {
      return try await library.entry(id: id)
    } catch {
      lastError = Self.describe(error)
      return nil
    }
  }

  // MARK: - Mutations

  func setEnabled(_ id: String, _ enabled: Bool) async {
    await perform { try await self.library.setEnabled(id: id, enabled: enabled) }
  }

  func delete(_ id: String) async {
    await perform { _ = try await self.library.delete(id: id) }
  }

  func save(id: String, code: String, name: String, version: String, description: String) async {
    await perform {
      _ = try await self.library.saveCode(id: id, code: code)
      try await self.library.saveMetadata(
        id: id, name: name, version: version, description: description)
    }
  }

  func create(kind: EntryKind) async {
    await perform { _ = try await self.library.create(kind: kind) }
  }

  func importFile(at url: URL) async {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    await perform { try await self.library.importFile(at: url) }
  }

  func exportData() async -> Data {
    (try? await library.exportData()) ?? Data()
  }

  // MARK: - Helpers

  private func perform(_ body: () async throws -> Void) async {
    do {
      try await body()
      await refresh()
    } catch {
      lastError = Self.describe(error)
    }
  }

  private static func describe(_ error: Error) -> String {
    if let error = error as? StoreError {
      switch error {
      case .notFound: return "条目不存在"
      case .badRequest(let message), .io(let message), .corruptIndex(let message): return message
      }
    }
    return String(describing: error)
  }

  /// File types the importer accepts.
  static var importTypes: [UTType] {
    // `.css` as a static member is macOS 15+; resolve it by extension instead.
    [.json, .javaScript, UTType(filenameExtension: "css") ?? .data]
  }
}

/// FileDocument wrapper so SwiftUI's exporter can write the bundle.
struct ExportDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.json] }

  var json: Data

  init(json: Data) {
    self.json = json
  }

  init(configuration: ReadConfiguration) throws {
    json = configuration.file.regularFileContents ?? Data()
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: json)
  }
}
