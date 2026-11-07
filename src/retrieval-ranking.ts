const ignored = new Set(
  "the a an of to in and or how what why does do is are about explain explaining find passages books my across with from fields field".split(
    " ",
  ),
);
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (t) => t.length > 2 && !ignored.has(t),
      ),
    ),
  ];
}
export function metadataScore(
  query: string,
  book: {
    title?: string;
    authors?: string[];
    genres?: string[];
    description?: string | null;
  },
): number {
  const terms = queryTerms(query);
  const title =
    `${book.title ?? ""} ${(book.authors ?? []).join(" ")} ${(book.genres ?? []).join(" ")}`.toLowerCase();
  const description = (book.description ?? "").toLowerCase();
  return terms.reduce(
    (score, t) =>
      score +
      (title.includes(t.length >= 7 ? t.slice(0, 6) : t)
        ? 2
        : description.includes(t.length >= 7 ? t.slice(0, 6) : t)
          ? 1
          : 0),
    0,
  );
}
