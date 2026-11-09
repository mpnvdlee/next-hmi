import { managerApiJson } from '@shared/utils/api';

/**
 * The sites allowed to show NEXT HMI in a frame (`/api/system/embedding`,
 * gated by the manager session; see backend/core/embed_settings.py). The
 * backend stores each as its canonical `scheme://host[:port]` and refuses
 * anything else with a message fit to show.
 */

type Embedding = { origins: string[] };

export const getEmbeddingOrigins = async () =>
  (await managerApiJson<Embedding>('/api/system/embedding')).origins;

export const saveEmbeddingOrigins = async (origins: string[]) =>
  (await managerApiJson<Embedding>('/api/system/embedding', { method: 'PUT', body: { origins } }))
    .origins;
