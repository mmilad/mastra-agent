import type { Mastra } from '@mastra/core';

let mastraRef: Mastra | undefined;

export function registerSignalRuntime(mastra: Mastra): void {
  mastraRef = mastra;
}

export function getSignalMastra(): Mastra | undefined {
  return mastraRef;
}