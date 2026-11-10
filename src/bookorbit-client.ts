import { createHash } from "node:crypto";
import type {
  Annotation,
  AnnotatedBookSummary,
  AnnotationHubPage,
  AuthorSummary,
  BookDetail,
  BookListItem,
  BookSearchResult,
  BookShelfType,
  CurrentlyReading,
  DashboardWidgetKind,
  EpubInfo,
  Library,
  LibraryStats,
  LibraryStatKind,
  MetadataFacetKind,
  NamedShelf,
  Paged,
  ReadingProgress,
  ReadingSessionsPage,
  RelatedBook,
  SeriesSummary,
  StatisticsSummary,
  UserStatisticsSummary,
  UserStatKind,
} from "./types.js";

/** How similar/related books are looked up (GET /books/{id}/...). */
export type RelatedKind = "similar" | "same_series" | "same_author";

/** Common native zero-based page/size options for catalog browse endpoints. */
export interface PageOpts {
  page?: number;
  size?: number;
}

export interface ClientConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Static Bearer token (dev only; not auto-refreshed). */
  token?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class BookOrbitError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "BookOrbitError";
  }
}

/** Encode an internal EPUB path, preserving "/" separators. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class BookOrbitClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null;
  private refreshCookie: string | null = null;
  private authInFlight: Promise<boolean> | null = null;
  private authRevision = 0;
  private authFailure: { error: unknown; retryAt: number } | null = null;

  constructor(private readonly config: ClientConfig) {
    this.apiBase = `${config.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.accessToken = config.token ?? null;
  }

  private get canReauthenticate(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /** Stable cache scope derived only from the upstream-authenticated account. */
  async annotationCacheNamespace(): Promise<string> {
    const user = await this.getJson<{ id: number | string }>("/auth/me");
    if (!(
      (typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0) ||
      (typeof user.id === "string" && user.id.length > 0)
    ))
      throw new Error("BookOrbit did not return an authenticated account identifier");
    return createHash("sha256")
      .update(JSON.stringify([this.apiBase, String(user.id), "annotation-v1"]))
      .digest("hex");
  }

  async assertLibraryUpload(libraryId: number): Promise<void> {
    const user = await this.getJson<{ isSuperuser?: boolean; permissions?: string[] }>(
      "/auth/me",
    );
    if (!user.isSuperuser && !user.permissions?.includes("library_upload"))
      throw new Error("Native BookOrbit upload permission is required");
    await this.queryBooks(0, 1, libraryId);
  }

  async uploadBook(
    libraryId: number,
    content: Buffer,
    filename: string,
  ): Promise<{ bookId: number }> {
    await this.assertLibraryUpload(libraryId);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(content)]), filename);
    const response = await this.authFetch(`/libraries/${libraryId}/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    return response.json() as Promise<{ bookId: number }>;
  }

  async searchBooks(query: string, limit?: number): Promise<BookSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (limit != null) params.set("limit", String(limit));
    return this.getJson<BookSearchResult[]>(`/books/search?${params}`);
  }

  async getBook(id: number): Promise<BookDetail> {
    const book = await this.getJson<BookDetail>(`/books/${id}`);
    // Browse returns names; deployed detail returns {id,name,...} entities.
    const names = (values: unknown): string[] =>
      Array.isArray(values)
        ? values.map((value) => (typeof value === "string" ? value : String(value.name)))
        : [];
    return {
      ...book,
      authors: names(book.authors),
      genres: names(book.genres),
      tags: names(book.tags),
    };
  }

  async getEpubInfo(bookId: number): Promise<EpubInfo> {
    return this.getJson<EpubInfo>(`/epub/${bookId}/info`);
  }

  /** Fetch one internal EPUB file (e.g. a chapter's XHTML) as text. */
  async getEpubFile(bookId: number, internalPath: string): Promise<string> {
    const res = await this.authFetch(`/epub/${bookId}/file/${encodePath(internalPath)}`);
    return res.text();
  }

  /** The books that have annotations (highlights/notes), with counts. */
  async listAnnotatedBooks(): Promise<AnnotatedBookSummary[]> {
    return this.getJson<AnnotatedBookSummary[]>(`/annotations/books`);
  }

  /** All of one book's annotations (highlights/notes). */
  async getAnnotations(bookId: number): Promise<Annotation[]> {
    return this.getJson<Annotation[]>(`/books/${bookId}/annotations`);
  }

  /** A page of the cross-library annotation hub. */
  async listAnnotations(opts?: {
    page?: number;
    pageSize?: number;
    bookId?: number;
  }): Promise<AnnotationHubPage> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set("page", String(opts.page));
    if (opts?.pageSize != null) params.set("pageSize", String(opts.pageSize));
    if (opts?.bookId != null) params.set("bookId", String(opts.bookId));
    const qs = params.toString();
    return this.getJson<AnnotationHubPage>(`/annotations${qs ? `?${qs}` : ""}`);
  }

  // --- discovery / browse (live, uncached) ---------------------------------

  /** Related books for one book: similar, same-series, or same-author. */
  async getRelatedBooks(bookId: number, kind: RelatedKind): Promise<RelatedBook[]> {
    const suffix =
      kind === "same_series"
        ? "series-books"
        : kind === "same_author"
          ? "author-books"
          : "recommendations";
    return this.getJson<RelatedBook[]>(`/books/${bookId}/${suffix}`);
  }

  /** A page of the library's series. */
  async listSeries(opts?: PageOpts): Promise<Paged<SeriesSummary>> {
    return this.getJson<Paged<SeriesSummary>>(`/series${pageQuery(opts)}`);
  }

  /** A page of the books in one series. */
  async getSeriesBooks(seriesId: number, opts?: PageOpts): Promise<Paged<BookListItem>> {
    return this.getJson<Paged<BookListItem>>(
      `/series/${seriesId}/books${pageQuery(opts)}`,
    );
  }

  /** A page of the library's authors (each with a bio). */
  async listAuthors(opts?: PageOpts): Promise<Paged<AuthorSummary>> {
    return this.getJson<Paged<AuthorSummary>>(`/authors${pageQuery(opts)}`);
  }

  /** One author, including their bio. */
  async getAuthor(authorId: number): Promise<AuthorSummary> {
    return this.getJson<AuthorSummary>(`/authors/${authorId}`);
  }

  /** A page of the books by one author. */
  async getAuthorBooks(authorId: number, opts?: PageOpts): Promise<Paged<BookListItem>> {
    return this.getJson<Paged<BookListItem>>(
      `/authors/${authorId}/books${pageQuery(opts)}`,
    );
  }

  /** The user's collections (curated shelves). */
  async listCollections(): Promise<NamedShelf[]> {
    return this.getJson<NamedShelf[]>(`/collections?bookIds=`);
  }

  /** A page of the books in one collection. */
  async getCollectionBooks(
    collectionId: number,
    opts?: PageOpts & { q?: string; collapseSeries?: boolean },
  ): Promise<Paged<BookListItem>> {
    const params = pageParams(opts);
    if (opts?.q != null) params.set("q", opts.q);
    if (opts?.collapseSeries != null)
      params.set("collapseSeries", String(opts.collapseSeries));
    return this.getJson<Paged<BookListItem>>(
      `/collections/${collectionId}/books?${params}`,
    );
  }

  /** The user's smart scopes (saved dynamic filters). */
  async listSmartScopes(): Promise<NamedShelf[]> {
    return this.getJson<NamedShelf[]>(`/smart-scopes`);
  }

  async getSmartScope(id: number): Promise<NamedShelf> {
    return this.getJson(`/smart-scopes/${id}`);
  }

  /** Native shelf writes: authorization and ownership remain upstream. */
  async createShelf(
    kind: "collections" | "smart-scopes",
    body: unknown,
  ): Promise<NamedShelf> {
    return this.sendJson(`/${kind}`, "POST", body);
  }

  async updateShelf(
    kind: "collections" | "smart-scopes",
    id: number,
    body: unknown,
  ): Promise<NamedShelf> {
    return this.sendJson(`/${kind}/${id}`, "PATCH", body);
  }

  async deleteShelf(kind: "collections" | "smart-scopes", id: number): Promise<void> {
    return this.sendJson(`/${kind}/${id}`, "DELETE", {});
  }

  async changeCollectionBooks(
    id: number,
    action: "add_books" | "remove_books",
    bookIds: number[],
  ): Promise<NamedShelf> {
    return this.sendJson(
      `/collections/${id}/books`,
      action === "add_books" ? "POST" : "DELETE",
      { bookIds },
    );
  }

  async collectionMembership(bookIds: number[]): Promise<NamedShelf[]> {
    return this.getJson(
      `/collections?${new URLSearchParams({ bookIds: bookIds.join(",") })}`,
    );
  }

  async previewScope(filter: unknown, sort: unknown): Promise<Paged<BookListItem>> {
    return this.sendJson("/books/query", "POST", {
      filter,
      sort,
      pagination: { page: 0, size: 10 },
    });
  }

  /** A page of the books matched by one smart scope. */
  async getSmartScopeBooks(
    scopeId: number,
    opts?: PageOpts & { q?: string },
  ): Promise<Paged<BookListItem>> {
    const params = pageParams(opts);
    if (opts?.q != null) params.set("q", opts.q);
    return this.getJson<Paged<BookListItem>>(`/smart-scopes/${scopeId}/books?${params}`);
  }

  // --- reading state (live, uncached) --------------------------------------

  /** Per-file reading progress for one book. */
  async getReadingProgress(bookId: number): Promise<ReadingProgress[]> {
    return this.getJson<ReadingProgress[]>(`/books/${bookId}/progress`);
  }

  /** Audiobook progress for one book (null when the book has no audio). */
  async getAudioProgress(bookId: number): Promise<unknown> {
    return this.getJson<unknown>(`/books/${bookId}/audio-progress`);
  }

  /** The books the user is currently reading, with progress. */
  async listCurrentlyReading(): Promise<CurrentlyReading> {
    return this.getJson<CurrentlyReading>(`/dashboard/widgets/currently-reading`);
  }

  /** A page of reading sessions for one book, plus aggregate stats. */
  async getReadingSessions(
    bookId: number,
    opts?: { page?: number; pageSize?: number },
  ): Promise<ReadingSessionsPage> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set("page", String(opts.page));
    if (opts?.pageSize != null) params.set("pageSize", String(opts.pageSize));
    const qs = params.toString();
    return this.getJson<ReadingSessionsPage>(
      `/books/${bookId}/sessions${qs ? `?${qs}` : ""}`,
    );
  }

  // --- statistics & libraries (live, uncached) -----------------------------

  /** Library-wide totals. */
  async getStatisticsSummary(): Promise<StatisticsSummary> {
    return this.getJson<StatisticsSummary>(`/statistics/summary`);
  }

  /** The user's personal reading totals. */
  async getUserStatisticsSummary(): Promise<UserStatisticsSummary> {
    return this.getJson<UserStatisticsSummary>(`/user-statistics/summary`);
  }

  /**
   * A metadata typeahead facet (authors/series/genres/…). `q` is a case- and
   * accent-insensitive "contains" match; an empty/whitespace `q` returns `[]`.
   * Body is passed through as-is (a bare `{ name }[]` or `{ id, name }[]` array).
   */
  async suggestMetadata(kind: MetadataFacetKind, q: string): Promise<unknown> {
    const params = new URLSearchParams({ q });
    return this.getJson<unknown>(`/metadata/${kind}?${params}`);
  }

  /**
   * One library-wide statistics chart (distributions, timelines, top-N, gauges).
   * Optionally scoped to `libraryIds`. Only `books-added-over-time` honors
   * `granularity`/`range`. Pre-aggregated body is passed through as-is.
   */
  async getLibraryStatistic(
    kind: LibraryStatKind,
    opts?: {
      libraryIds?: number[];
      granularity?: "monthly" | "yearly";
      range?: "last-year" | "last-5-years" | "all-time";
    },
  ): Promise<unknown> {
    const params = statsParams(opts?.libraryIds);
    if (opts?.granularity != null) params.set("granularity", opts.granularity);
    if (opts?.range != null) params.set("range", opts.range);
    const qs = params.toString();
    return this.getJson<unknown>(`/statistics/${kind}${qs ? `?${qs}` : ""}`);
  }

  /**
   * One personal reading-statistics chart, optionally scoped to `libraryIds` and a
   * trailing `days` window. Per-kind extras (`year`/`week`, `comparePrevious`,
   * `goalBooks`) are forwarded when provided; the server ignores irrelevant ones.
   * Pre-aggregated body is passed through as-is.
   */
  async getUserStatistic(
    kind: UserStatKind,
    opts?: {
      libraryIds?: number[];
      days?: number;
      year?: number;
      week?: number;
      comparePrevious?: boolean;
      goalBooks?: number;
    },
  ): Promise<unknown> {
    const params = statsParams(opts?.libraryIds);
    if (opts?.days != null) params.set("days", String(opts.days));
    if (opts?.year != null) params.set("year", String(opts.year));
    if (opts?.week != null) params.set("week", String(opts.week));
    if (opts?.comparePrevious != null)
      params.set("comparePrevious", String(opts.comparePrevious));
    if (opts?.goalBooks != null) params.set("goalBooks", String(opts.goalBooks));
    const qs = params.toString();
    return this.getJson<unknown>(`/user-statistics/${kind}${qs ? `?${qs}` : ""}`);
  }

  /** One dashboard "headline card" widget (streak, goal, projection, …). */
  async getDashboardWidget(kind: DashboardWidgetKind): Promise<unknown> {
    return this.getJson<unknown>(`/dashboard/widgets/${kind}`);
  }

  /**
   * One curated dashboard book shelf (recently-added, want-to-read, up-next-in-
   * series, …). `smart-scope` requires `smartScopeId`. Normalizes old and new API responses.
   */
  async getBookShelf(
    type: BookShelfType,
    opts?: { limit?: number; smartScopeId?: number },
  ): Promise<BookListItem[]> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.smartScopeId != null) params.set("smartScopeId", String(opts.smartScopeId));
    const qs = params.toString();
    const path = `/dashboard/scrollers/${type}${qs ? `?${qs}` : ""}`;
    const result = await this.getJson<BookListItem[] | { books: BookListItem[] }>(path);
    const books = Array.isArray(result) ? result : result?.books;
    if (!Array.isArray(books))
      throw new BookOrbitError("Invalid shelf response", 502, path);
    return books;
  }

  /** One collection's detail (companion to getCollectionBooks). */
  async getCollection(id: number): Promise<unknown> {
    return this.getJson<unknown>(`/collections/${id}`);
  }

  /** Search external providers for author-metadata candidates (bio enrichment). */
  async searchAuthorMetadata(
    q: string,
    opts?: { region?: string; limit?: number; providers?: string },
  ): Promise<unknown> {
    const params = new URLSearchParams({ q });
    if (opts?.region != null) params.set("region", opts.region);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.providers != null) params.set("providers", opts.providers);
    return this.getJson<unknown>(`/authors/metadata/search?${params}`);
  }

  /** Fetch a raw image (cover/thumbnail) as bytes plus its content type. */
  async getImage(path: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.authFetch(path);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** A book's cover image (full-size or thumbnail). */
  async getBookCover(
    bookId: number,
    size: "full" | "thumbnail",
  ): Promise<{ data: Buffer; contentType: string }> {
    return this.getImage(
      `/books/${bookId}/${size === "thumbnail" ? "thumbnail" : "cover"}`,
    );
  }

  /** An author's image (full-size or thumbnail). */
  async getAuthorImage(
    authorId: number,
    size: "full" | "thumbnail",
  ): Promise<{ data: Buffer; contentType: string }> {
    return this.getImage(
      `/authors/${authorId}/${size === "thumbnail" ? "thumbnail" : "image"}`,
    );
  }

  /** All libraries (the raw per-library config blob). */
  async listLibraries(): Promise<Library[]> {
    return this.getJson<Library[]>(`/libraries`);
  }

  /** Book/size/format stats for one library. */
  async getLibraryStats(libraryId: number): Promise<LibraryStats> {
    return this.getJson<LibraryStats>(`/libraries/${libraryId}/stats`);
  }

  /** Current authorized catalog, with stable pagination (never a search-limit sample). */
  async queryBooks(
    page = 0,
    size = 100,
    libraryId?: number,
  ): Promise<{ items: BookListItem[]; total: number }> {
    const path = libraryId == null ? "/books/query" : `/libraries/${libraryId}/books`;
    return this.sendJson(path, "POST", {
      pagination: { page, size },
      sort: [{ field: "addedAt", dir: "asc" }],
    });
  }

  async downloadFile(fileId: number, maxBytes = 80 * 1024 * 1024): Promise<Buffer> {
    const res = await this.authFetch(`/books/files/${fileId}/download`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (Number(res.headers.get("content-length")) > maxBytes) {
      await res.body?.cancel();
      throw new Error(
        `Book exceeds extraction download limit (${Math.floor(maxBytes / 1024 / 1024)} MiB)`,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes)
          throw new Error(
            `Book exceeds extraction download limit (${Math.floor(maxBytes / 1024 / 1024)} MiB)`,
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }

  async searchBookMetadata(
    title: string,
    author?: string,
    isbn?: string,
  ): Promise<unknown[]> {
    const params = new URLSearchParams({ title, resultsPerProvider: "3" });
    if (author) params.set("author", author);
    if (isbn) params.set("isbn", isbn);
    const response = await this.authFetch(`/metadata-fetch/stream?${params}`, {
      signal: AbortSignal.timeout(90_000),
    });
    return this.readSse(response);
  }

  async organizeBooks(libraryId: number, bookIds: number[]): Promise<unknown[]> {
    const response = await this.authFetch(`/libraries/${libraryId}/bulk-rename/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeBookIds: bookIds }),
      signal: AbortSignal.timeout(180_000),
    });
    return this.readSse(response);
  }

  private async readSse(response: Response): Promise<unknown[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: unknown[] = [];
    let pending = "";
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2 * 1024 * 1024)
          throw new Error("Provider metadata response exceeded 2 MiB");
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let end;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const raw = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (raw) events.push(JSON.parse(raw));
          if (events.length > 500)
            throw new Error(
              "Native operation exceeded 500 progress events; check its status before retrying",
            );
        }
      }
    } finally {
      await reader.cancel();
    }
    return events;
  }

  async getLibrary(id: number): Promise<Library> {
    return this.getJson(`/libraries/${id}`);
  }
  async updateLibrary(id: number, patch: unknown): Promise<Library> {
    return this.sendJson(`/libraries/${id}`, "PATCH", patch);
  }
  async getFetchConfig(id: number): Promise<unknown> {
    return this.getJson(`/book-metadata-fetch/config/libraries/${id}`);
  }
  async updateFetchConfig(id: number, config: unknown): Promise<unknown> {
    return this.sendJson(`/book-metadata-fetch/config/libraries/${id}`, "PUT", config);
  }
  async fetchMetadata(id: number): Promise<unknown> {
    return this.sendJson(`/book-metadata-fetch/run/${id}`, "POST", {});
  }
  async getFetchStatus(): Promise<unknown> {
    return this.getJson("/book-metadata-fetch/status");
  }
  async previewRename(id: number): Promise<unknown> {
    return this.getJson(`/libraries/${id}/bulk-rename/preview?pageSize=50`);
  }
  async updateMetadata(id: number, patch: unknown): Promise<unknown> {
    return this.sendJson(`/books/${id}/metadata`, "PATCH", patch);
  }

  private async sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
    const res = await this.authFetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  // --- internals -----------------------------------------------------------

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.authFetch(path);
    return (await res.json()) as T;
  }

  /** Fetch with Bearer auth, refreshing / re-logging in once on a 401. */
  private async authFetch(path: string, init: RequestInit = {}): Promise<Response> {
    // Share cold logins and wait for an ongoing refresh before sending requests.
    if (this.authInFlight) await this.authInFlight;
    if (!this.accessToken && this.canReauthenticate) await this.authenticate();

    const revision = this.authRevision;
    let res = await this.rawFetch(path, init);
    if (res.status === 401 && (this.canReauthenticate || this.refreshCookie)) {
      const recovered = await this.authenticate(revision);
      if (recovered) res = await this.rawFetch(path, init);
    }

    if (!res.ok) {
      const message = await this.extractError(res);
      throw new BookOrbitError(message, res.status, path);
    }
    return res;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    return this.fetchImpl(`${this.apiBase}${path}`, {
      signal: AbortSignal.timeout(30_000),
      ...init,
      headers,
    });
  }

  /** One authentication attempt per client, including failures and delayed 401s. */
  private async authenticate(failedRevision?: number): Promise<boolean> {
    if (this.authInFlight) return this.authInFlight;
    // Another request may have recovered while this request's 401 was in flight.
    if (failedRevision != null && failedRevision !== this.authRevision) return true;
    if (this.authFailure && Date.now() < this.authFailure.retryAt) {
      throw this.authFailure.error;
    }

    const pending = this.reauthenticate();
    this.authInFlight = pending;
    try {
      const recovered = await pending;
      this.authFailure = null;
      return recovered;
    } catch (error) {
      // Never turn an outage or invalid credentials into a tool-driven login storm.
      const delay =
        error instanceof BookOrbitError
          ? (error.retryAfterMs ??
            ([401, 403, 429].includes(error.status) ? 60_000 : 5_000))
          : 5_000;
      this.authFailure = { error, retryAt: Date.now() + delay };
      throw error;
    } finally {
      this.authInFlight = null;
    }
  }

  /** Refresh first; only rejected refresh credentials justify a full login. */
  private async reauthenticate(): Promise<boolean> {
    if (this.refreshCookie) {
      try {
        await this.refresh();
        return true;
      } catch (error) {
        // 429, network failures and server errors must not trigger password login.
        if (!(error instanceof BookOrbitError) || error.status !== 401) throw error;
        this.refreshCookie = null;
      }
    }
    if (this.canReauthenticate) {
      await this.login();
      return true;
    }
    return false;
  }

  private async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/auth/login`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });
    if (!res.ok) {
      throw new BookOrbitError(
        `Login failed: ${await this.extractError(res)}`,
        res.status,
        "/auth/login",
        this.retryAfter(res),
      );
    }
    await this.acceptCredentials(res, true);
  }

  private async refresh(): Promise<void> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.refreshCookie) headers.set("Cookie", `refresh_token=${this.refreshCookie}`);
    const res = await this.fetchImpl(`${this.apiBase}/auth/refresh`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers,
    });
    if (!res.ok) {
      throw new BookOrbitError(
        "Token refresh failed",
        res.status,
        "/auth/refresh",
        this.retryAfter(res),
      );
    }
    await this.acceptCredentials(res, false);
  }

  private async acceptCredentials(res: Response, newSession: boolean): Promise<void> {
    const body = (await res.json()) as { accessToken?: string };
    if (typeof body.accessToken !== "string" || !body.accessToken.trim()) {
      throw new BookOrbitError("Invalid authentication response", 502, "/auth");
    }
    this.accessToken = body.accessToken;
    if (newSession) this.refreshCookie = null;
    this.captureRefreshCookie(res);
    this.authRevision++;
  }

  private retryAfter(res: Response): number | undefined {
    const value = res.headers.get("retry-after");
    if (!value) return undefined;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.max(1000, delay) : undefined;
  }

  private captureRefreshCookie(res: Response): void {
    const cookies = getSetCookies(res);
    for (const cookie of cookies) {
      const match = /^refresh_token=([^;]+)/.exec(cookie);
      if (match) this.refreshCookie = match[1];
    }
  }

  private async extractError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { message?: string | string[] };
      const msg = body.message;
      if (Array.isArray(msg)) return msg.join("; ");
      if (msg) return msg;
    } catch {
      // non-JSON body
    }
    return `${res.status} ${res.statusText}`;
  }
}

/** Build page/size query params (both optional). */
function pageParams(opts?: PageOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.size != null) params.set("size", String(opts.size));
  return params;
}

/** page/size as a leading-"?" query string, or "" when empty. */
function pageQuery(opts?: PageOpts): string {
  const qs = pageParams(opts).toString();
  return qs ? `?${qs}` : "";
}

/** Build a statistics query with a repeatable `libraryIds` key (?libraryIds=1&libraryIds=2). */
function statsParams(libraryIds?: number[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of libraryIds ?? []) params.append("libraryIds", String(id));
  return params;
}

/** Read Set-Cookie headers across runtimes (undici exposes getSetCookie). */
function getSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}
