/**
 * InfinMonkey deno lint 插件。
 *
 * 规则 no-leaf-exports：content/inject 是被 manifest 直接声明的叶子 bundle
 * （IIFE 产物），不应出现任何形式的 export——它们之间不存在互相导入，
 * 导出只可能是死代码或错误的跨上下文引用。跨文件 unused-export 分析
 * 因 lint 插件缺少 finalize 钩子无法表达，见 `deno task unused`。
 */
interface ReportContext {
  filename: string;
  report: (o: { node: unknown; message: string }) => void;
}

const LEAF_RE = /[\\/](content|inject)[\\\/]src[\\/]/;
const LEAF_MSG = "叶子 bundle（content/inject）不允许导出内容：它们被 manifest 直接声明为独立入口";

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
