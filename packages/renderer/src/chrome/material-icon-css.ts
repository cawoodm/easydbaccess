import { css } from 'lit';

/**
 * Reusable Material Icons rules for shadow-DOM components.
 *
 * The font itself is loaded once globally via the `material-icons/iconfont/...`
 * import in `main.ts`; @font-face declared in the document stylesheet is
 * accessible inside shadow roots, but class rules in the document stylesheet
 * are NOT. So each component that wants the .mi class brings its own copy.
 *
 * Use `mi` (short) instead of `material-icons` to avoid name clashes with
 * potential plugin styles in the same scope.
 */
export const materialIconStyles = css`
  .mi {
    font-family: 'Material Icons';
    font-weight: normal;
    font-style: normal;
    font-size: 1.15rem;
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    display: inline-block;
    white-space: nowrap;
    word-wrap: normal;
    direction: ltr;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-feature-settings: 'liga';
    vertical-align: middle;
  }
  .mi.sm {
    font-size: 1rem;
  }
  .mi.lg {
    font-size: 1.4rem;
  }
`;
