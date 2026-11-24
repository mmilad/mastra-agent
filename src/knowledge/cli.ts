import { findWorkspaceRoot } from '../context/scope.ts';
import { syncProjectKnowledge } from './sync.ts';

const projectRoot = findWorkspaceRoot();
const result = await syncProjectKnowledge(projectRoot);
console.log(
  `Synced project knowledge for ${projectRoot}: ${result.written} written, ${result.unchanged} unchanged, ${result.removed} removed.`,
);
process.exit(0);
