import type { ReactNode } from 'react';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';
import Icon, { LinkGlyphPaths, GlobeGlyphPaths } from '../../ui/glyphIcon';

/** One hand-authored inline SVG glyph per property source. See `glyphIcon.tsx`.
 *  The 24×24-viewBox glyphs below (static/$var/$loc/$if/$compare/$random/$switch/
 *  $componentProp) come from the property-panel design sandbox; the rest still
 *  use the original 16×16 set. */

const ICONS: Record<PropertySource, ReactNode> = {
  // Static value — an outlined rounded square.
  static: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="6" y="6" width="12" height="12" rx="3" />
    </Icon>
  ),
  // $var — bound link.
  $var: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <LinkGlyphPaths />
    </Icon>
  ),
  // $loc — map pin.
  $loc: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </Icon>
  ),
  // $urlParam — link.
  $urlParam: (
    <Icon>
      <path d="M6.8 9.2 L9.2 6.8" />
      <path d="M7.6 4.6 L9 3.2 a2.2 2.2 0 0 1 3.1 3.1 L10.7 7.7" />
      <path d="M8.4 11.4 L7 12.8 a2.2 2.2 0 0 1 -3.1 -3.1 L5.3 8.3" />
    </Icon>
  ),
  // $pageIsActive — page with a check.
  $pageIsActive: (
    <Icon>
      <path d="M4 2.5 h6.5 L13 5 v8.5 H4 Z" />
      <path d="M6 8.3 L7.4 9.7 L10.3 6.6" />
    </Icon>
  ),
  // $if — branch fork.
  $if: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <path d="M12 4v5" />
      <path d="M12 9c0 3.5-4.5 3-4.5 7" />
      <path d="M12 9c0 3.5 4.5 3 4.5 7" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // $compare — weighted brackets.
  $compare: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <path d="M12 3v18" />
      <path d="M5 8l-2 5a3 3 0 0 0 6 0L5 8" />
      <path d="M19 8l-2 5a3 3 0 0 0 6 0l-2-5" />
      <path d="M5 8h4M15 8h4M9 3h6" />
    </Icon>
  ),
  // $random — die face.
  $random: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="16" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // $switch — track with two stops.
  $switch: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <path d="M12 3v4" />
      <path d="M12 7c0 3-5 2-5 6v4" />
      <path d="M12 7v13" />
      <path d="M12 7c0 3 5 2 5 6v4" />
      <circle cx="12" cy="3" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="7" cy="20" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // $user — person.
  $user: (
    <Icon>
      <circle cx="8" cy="5.2" r="2.4" />
      <path d="M3.2 13.2 a4.8 4.2 0 0 1 9.6 0" />
    </Icon>
  ),
  // $userGroups — group of people.
  $userGroups: (
    <Icon>
      <circle cx="5.6" cy="6" r="2" />
      <circle cx="10.4" cy="6" r="2" />
      <path d="M1.8 13 a3.8 3.4 0 0 1 7.6 0 M6.6 13 a3.8 3.4 0 0 1 7.6 0" />
    </Icon>
  ),
  // $device — monitor.
  $device: (
    <Icon>
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
      <path d="M6 13.2 h4 M8 10.5 v2.7" />
    </Icon>
  ),
  // $time — clock.
  $time: (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5 v3.2 l2.4 1.4" />
    </Icon>
  ),
  // $widgetProp — value exported out of a box.
  $widgetProp: (
    <Icon>
      <rect x="2.5" y="6" width="7" height="7" rx="1" />
      <path d="M9 6 L13.2 2.5 M9.5 2.5 h3.7 v3.7" />
    </Icon>
  ),
  // $languages — globe.
  $languages: (
    <Icon>
      <GlobeGlyphPaths />
    </Icon>
  ),
  // $stringExpr — template braces.
  $stringExpr: (
    <Icon>
      <path d="M6 2.8 c-1.6 0 -1.6 1.6 -1.6 2.6 s0 1 -1.4 1 M4.4 6.4 c1.4 0 1.4 0.4 1.4 1 s0 2.6 1.6 2.6" />
      <path d="M10 2.8 c1.6 0 1.6 1.6 1.6 2.6 s0 1 1.4 1 M11.6 6.4 c-1.4 0 -1.4 0.4 -1.4 1 s0 2.6 -1.6 2.6" />
    </Icon>
  ),
  // $http — cloud with a down-arrow (a value fetched from an endpoint).
  $http: (
    <Icon>
      <path d="M4.6 11 a2.6 2.6 0 0 1 0.2 -5.2 a3.4 3.4 0 0 1 6.5 0.6 a2.3 2.3 0 0 1 -0.3 4.6" />
      <path d="M8 6.8 v5.4" />
      <path d="M6.2 10.6 L8 12.4 L9.8 10.6" />
    </Icon>
  ),
  // $alarmCount — bell.
  $alarmCount: (
    <Icon>
      <path d="M8 2.6 a3.4 3.4 0 0 1 3.4 3.4 c0 3.4 1.2 4.2 1.2 4.6 H3.4 c0 -0.4 1.2 -1.2 1.2 -4.6 A3.4 3.4 0 0 1 8 2.6 Z" />
      <path d="M6.6 12.6 a1.5 1.5 0 0 0 2.8 0" />
    </Icon>
  ),
  // $recipe — bookmarked document.
  $recipe: (
    <Icon>
      <path d="M4 2.5 h8 v11 l-2.5 -2 l-2.5 2 l-2.5 -2 Z" />
      <path d="M6 6 h4 M6 8.4 h4" />
    </Icon>
  ),
  // $recipeList — stacked rows.
  $recipeList: (
    <Icon>
      <path d="M2.7 4.5 h10.6 M2.7 8 h10.6 M2.7 11.5 h10.6" />
    </Icon>
  ),
  // $componentProp — value handed in.
  $componentProp: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // $page — plain page.
  $page: (
    <Icon>
      <path d="M4 2.5 h5.5 L13 6 v7.5 H4 Z" />
      <path d="M9.5 2.5 v3.5 H13" />
    </Icon>
  ),
  // $viewport — resize corners.
  $viewport: (
    <Icon>
      <path d="M2.5 5.5 v-3 h3 M13.5 5.5 v-3 h-3 M2.5 10.5 v3 h3 M13.5 10.5 v3 h-3" />
      <rect x="5" y="5" width="6" height="6" rx="0.5" />
    </Icon>
  ),
  // $viewport uses full corner-bracket glyph above.
  // $result — return arrow.
  $result: (
    <Icon>
      <path d="M6 4.5 L2.5 8 L6 11.5" />
      <path d="M2.5 8 h7.5 a3 3 0 0 0 3 -3 v-1.5" />
    </Icon>
  ),
};

export default ICONS;
