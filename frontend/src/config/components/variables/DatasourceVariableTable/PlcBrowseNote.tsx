import { useMemo } from 'react';
import type { TreeNode } from '@shared/types/datasource';
import type { BrowseMode } from './useAdsPlcBrowse';
import type { BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { savedNodeIds } from './browseMerge';
import type { PlcMarks } from './plcRows';

interface Props {
  browse: {
    nodes: BrowseNode[] | null;
    mode: BrowseMode;
    found: number;
    error: string | null;
  };
  /** The check of the saved variables against the PLC, once it answered. */
  marks: PlcMarks | null;
  savedTree: TreeNode[];
  /** The PLC variables (loaded so far) the datasource does not have. */
  newCount: number;
  filtering: boolean;
  /** `browse_attributes` of the datasource, for the empty marked-browse message. */
  attributes?: string;
}

/** The lines above the table while it shows the PLC (ADS Browse PLC). */
export default function PlcBrowseNote({ marks, savedTree, ...rest }: Props) {
  // Counted over the tree in the table: a variable removed since stays uncounted.
  const counts = useMemo(() => {
    if (!marks) return null;
    const ids = savedNodeIds(savedTree);
    let missing = 0;
    let changed = 0;
    for (const id of ids) {
      if (marks.missing.has(id)) missing += 1;
      else if (marks.changed.has(id)) changed += 1;
    }
    return { missing, changed };
  }, [marks, savedTree]);
  return (
    <>
      <BrowseLine {...rest} />
      {marks?.error && (
        <p className="cfg-var-plc-note" role="status">
          The saved variables could not be checked against the PLC: {marks.error}
        </p>
      )}
      {counts && (counts.missing > 0 || counts.changed > 0) && (
        <p className="cfg-var-plc-note" role="status">
          {counts.missing > 0 && (
            <span className="cfg-var-plc-count cfg-var-plc-count--missing">
              {counts.missing === 1 ? '1 variable' : `${counts.missing} variables`} no longer on the
              PLC
            </span>
          )}
          {counts.changed > 0 && (
            <span className="cfg-var-plc-count cfg-var-plc-count--changed">
              {counts.changed === 1 ? '1 variable' : `${counts.changed} variables`} with another
              data type on the PLC
            </span>
          )}
        </p>
      )}
    </>
  );
}

function BrowseLine({
  browse,
  newCount,
  filtering,
  attributes,
}: Omit<Props, 'marks' | 'savedTree'>) {
  const { nodes, mode, found, error } = browse;
  if (error) return <div className="cfg-error-banner">{error}</div>;
  if (nodes === null) {
    return (
      <p className="cfg-var-plc-note" role="status">
        Browsing the PLC…
      </p>
    );
  }
  if (found === 0) {
    const attribute = attributes?.split(',')[0]?.trim() || 'OPC.UA.DA';
    return (
      <p className="cfg-var-plc-note" role="status">
        {mode === 'marked' ? (
          <>
            Nothing on the PLC carries <code>{`{attribute '${attribute}' := '1'}`}</code>, so a
            marked browse finds no variables. Add that attribute to the variables to show, or in
            this datasource’s Browse settings set Browse Mode to Lazy (one level) or change Browse
            Attributes.
          </>
        ) : (
          'The PLC has no variables to show here.'
        )}
      </p>
    );
  }
  if (mode !== 'lazy' && newCount === 0) {
    return (
      <p className="cfg-var-plc-note" role="status">
        Every variable this browse found is already in this datasource.
      </p>
    );
  }
  return (
    <p className="cfg-var-plc-note">
      Grey italic rows are on the PLC but not in this datasource yet: tick one to add it, or a
      folder to add everything new in it. A member added in one element of a struct array is added
      for every element; elements are numbered from 0 here, so aPoints[1] on the PLC is aPoints[0].
      {mode === 'lazy' &&
        (filtering
          ? ' The filter searches only the folders opened so far.'
          : ' Open a folder to load what is in it.')}
    </p>
  );
}
