/// <reference types="vite/client" />

import type { CorpusViewerApi } from '@shared/types';

declare global {
  interface Window {
    corpusViewer: CorpusViewerApi;
  }
}
