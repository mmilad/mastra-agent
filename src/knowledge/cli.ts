import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspaceRoot } from '../context/scope.ts';
import { buildKnowledgeIndex, knowledgeDatabaseUrl } from './index-store.ts';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoot = findWorkspaceRoot();
const result = await buildKnowledgeIndex({ projectRoot, databaseUrl: knowledgeDatabaseUrl(applicationRoot) });
console.log(`Indexed ${result.files} files into ${result.chunks} chunks (index ${result.indexName}) for ${projectRoot}.`);
