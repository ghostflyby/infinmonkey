/**
 * InfinMonkey deno lint plugin.
 *
 * Rule no-leaf-exports: content/inject are leaf bundles declared directly by the manifest
 * (IIFE artifacts) and must not contain any form of export — they never import each other,
 * so an export can only be dead code or a mistaken cross-context reference. Cross-file unused-export analysis
 * cannot be expressed because lint plugins lack a finalize hook; see `deno task unused`.
 */
interface ReportContext {
  filename: string;
  report: (o: { node: unknown; message: string }) => void;
}

const LEAF_RE = /[\\/](content|inject)[\\\/]src[\\/]/;
const LEAF_MSG =
  "leaf bundle (content/inject) must not export anything: they are declared as standalone entries by the manifest";

export default {
  name: "infinmonkey-lint",
  rules: {
    "no-leaf-exports": {
      create(context: ReportContext) {
        const isLeaf = LEAF_RE.test(context.filename);
        return {
          ExportNamedDeclaration(node: unknown) {
            if (isLeaf) context.report({ node, message: LEAF_MSG });
          },
          ExportDefaultDeclaration(node: unknown) {
            if (isLeaf) context.report({ node, message: LEAF_MSG });
          },
          ExportAll(node: unknown) {
            if (isLeaf) context.report({ node, message: LEAF_MSG });
          },
        };
      },
    },
  },
};
