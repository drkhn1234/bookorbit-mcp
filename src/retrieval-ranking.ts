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
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const title = words(
    `${book.title ?? ""} ${(book.authors ?? []).join(" ")} ${(book.genres ?? []).join(" ")}`,
  );
  const description = words(book.description ?? "");
  const matches = (values: string[], term: string) =>
    values.some((word) =>
      term.length >= 7 ? word.startsWith(term.slice(0, 6)) : word === term,
    );
  return terms.reduce(
    (score, t) => score + (matches(title, t) ? 2 : matches(description, t) ? 1 : 0),
    0,
  );
}
