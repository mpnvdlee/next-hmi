---
name: frontend-audit
description: Audit the NEXT HMI frontend for simplification, deduplication, and consistency wins. Use when asked for a frontend audit, a simplification or deduplication sweep, or "what can we merge or delete in the frontend".
---

Audit the NEXT HMI frontend at `frontend/src` for **simplification, deduplication, and consistency** opportunities. React 19 + TypeScript + Vite + Zustand. The product widgets in `frontend/widgets/` are in scope too.

I want concrete findings, not vague suggestions. For each issue, give file paths + line numbers and a one-line "what to do".

Specifically look for:

1. **Duplicated logic** — same helper/util/hook implemented twice; near-identical components (modals, trees, pickers, panels) that could share a base; copy-pasted Zustand store boilerplate; repeated type guards or property-source handling (`$static`/`$var`/`$loc`/etc. — see `shared/types/propertyValueGuards.ts`).

2. **Inconsistent patterns** —
   - Store conventions across `shared/store/*`, `config/store/*`, `hmi/store/*`.
   - Naming: `*View` vs `*Page`, `*Panel` vs `*Section`, `use*Data` vs `use*`, `*Modal` vs `*Dialog` vs `*Popup`.
   - Tree/virtualizer code: `WidgetTree`, `DatasourceTree`, `UsersTree`, `DictionaryTree`, `AlarmTree`, `ComponentTree`, `VirtualTreeRows`.
   - Modal shells: `ModalShell`, `ConfirmModal`, `NameInputModal`, `PropertyDialog`, `MoveDialog`, `StructSchemaPopup`, `AlertModal`.
   - Picker shells: `BindingPickerShell`, `AssetPickerShell`, `ImageSourcePicker`, `IconSourcePicker`, `VariableBindingPicker`, `ComponentPropPicker`.

3. **Oversized files** — open the largest 10 (start with `wc -l` ranking, ignore tests). Judge if they could be cleanly split.

4. **Dead or trivially-redundant code** — re-exports that just rename, single-call helpers, unused exports, two utils files solving the same problem.

5. **Type duplication** — overlapping shapes between `shared/types/*` and inline component types; `widgetTypes.ts`, `componentSchema.ts`, `config.ts` overlap?

6. **Config/HMI parallels** — note any place where the same logic is implemented twice across `src/config` and `src/hmi`.

Pick the **15–25 highest-leverage findings**. Group by theme (Duplication / Inconsistency / Oversized / Dead code / Types). Each finding: 1–2 lines, with `file:line` references.

Skip nitpicks (formatting, comments, minor naming). Verify the top findings by reading the cited code before reporting.

End with a prioritized "Top N if you only do N" list.
