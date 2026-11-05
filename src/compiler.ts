/** @farm.js/islx/compiler: source transforms for bundler plugins. Runs in Node. */
export {
  ActionCompileError,
  getActionId,
  hasModuleDirective,
  transformActions,
  type AstNode,
  type TransformActionsOptions,
  type TransformActionsResult,
} from "./compiler/actions";
export { inferStrategy, type Inference, type InferOptions } from "./compiler/infer";
