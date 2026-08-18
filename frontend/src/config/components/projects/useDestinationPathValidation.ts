import { useEffect, useState } from 'react';
import { useProjectsStore } from '@config/store/projectsStore';

interface DestinationPathValidation {
  ok: boolean;
  message: string;
}

interface Options {
  createdMessage?: string;
  missingReason?: string;
  formatReason?: (reason: string) => string;
  requireAbsent?: boolean;
}

const identity = (value: string) => value;

/** Debounced validation shared by project destinations that must be empty or absent. */
export function useDestinationPathValidation(
  path: string,
  {
    createdMessage = 'Path will be created.',
    missingReason = 'Invalid path',
    formatReason = identity,
    requireAbsent = false,
  }: Options = {},
): DestinationPathValidation | null {
  const validate = useProjectsStore((s) => s.validatePath);
  const [validation, setValidation] = useState<DestinationPathValidation | null>(null);

  useEffect(() => {
    if (!path.trim()) {
      setValidation(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const result = await validate(path);
      if (cancelled) return;
      if (!result.ok) {
        setValidation({
          ok: false,
          message: formatReason(result.reason ?? missingReason),
        });
      } else if (result.exists && requireAbsent) {
        setValidation({ ok: false, message: 'Destination path already exists.' });
      } else if (result.exists && result.isEmpty === false) {
        setValidation({ ok: false, message: 'Destination directory is not empty.' });
      } else {
        setValidation({
          ok: true,
          message: result.exists ? 'Empty directory will be reused.' : createdMessage,
        });
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [createdMessage, formatReason, missingReason, path, requireAbsent, validate]);

  return validation;
}
