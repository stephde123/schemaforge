import type { EntityGraph } from "./types.js";

/** Serialize the internal graph to a JSON-LD document with @context + @graph. */
export function toJsonLd(graph: EntityGraph): Record<string, unknown> {
  const nodes = graph.entities.map((e) => {
    const node: Record<string, unknown> = { "@type": e.type };
    if (e.id) node["@id"] = e.id;
    Object.assign(node, e.props);
    return node;
  });

  if (nodes.length === 1) {
    return { "@context": "https://schema.org", ...nodes[0] };
  }
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** Wrap JSON-LD in a ready-to-paste <script> tag. */
export function toScriptTag(jsonld: Record<string, unknown>): string {
  return `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n</script>`;
}
