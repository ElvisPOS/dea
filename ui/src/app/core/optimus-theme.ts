import { definePreset } from '@openng/optimus-ui-themes';
import Aura from '@openng/optimus-ui-themes/aura';

/**
 * Optimus UI theme for DEA: Aura with the colours of the design system.
 * Semantic colours point at the CSS variables in styles/_tokens.scss, so the
 * components follow the light/dark switch and any change made there. The
 * surface ramps (used by a few component tokens directly) match the same
 * greys. Sizes are in rem: html is 12px (styles/_base.scss), which gives the
 * 30px controls of the design system.
 */
const scheme = (surface: Record<string, string>) => ({
  surface,
  primary: {
    color: 'var(--accent)',
    contrastColor: 'var(--accent-ink)',
    hoverColor: 'color-mix(in srgb, var(--accent), white 10%)',
    activeColor: 'color-mix(in srgb, var(--accent), white 18%)',
  },
  highlight: {
    background: 'var(--accent-soft)',
    focusBackground: 'var(--accent-soft)',
    color: 'var(--accent-soft-ink)',
    focusColor: 'var(--accent-soft-ink)',
  },
  mask: { background: 'rgba(0, 0, 0, .45)', color: 'var(--ink)' },
  formField: {
    background: 'var(--bg-surface)',
    disabledBackground: 'var(--bg-sunken)',
    filledBackground: 'var(--bg-sunken)',
    filledHoverBackground: 'var(--bg-sunken)',
    filledFocusBackground: 'var(--bg-sunken)',
    borderColor: 'var(--border-strong)',
    hoverBorderColor: 'var(--ink-subtle)',
    focusBorderColor: 'var(--accent)',
    invalidBorderColor: 'var(--crit)',
    color: 'var(--ink)',
    disabledColor: 'var(--ink-subtle)',
    placeholderColor: 'var(--ink-subtle)',
    invalidPlaceholderColor: 'var(--crit-ink)',
    floatLabelColor: 'var(--ink-subtle)',
    floatLabelFocusColor: 'var(--accent)',
    floatLabelActiveColor: 'var(--ink-subtle)',
    floatLabelInvalidColor: 'var(--crit-ink)',
    iconColor: 'var(--ink-subtle)',
    shadow: 'none',
  },
  text: { color: 'var(--ink)', hoverColor: 'var(--ink)', mutedColor: 'var(--ink-muted)', hoverMutedColor: 'var(--ink)' },
  content: {
    background: 'var(--bg-surface)',
    hoverBackground: 'var(--bg-hover)',
    borderColor: 'var(--border)',
    color: 'var(--ink)',
    hoverColor: 'var(--ink)',
  },
  overlay: {
    select: { background: 'var(--bg-surface)', borderColor: 'var(--border)', color: 'var(--ink)' },
    popover: { background: 'var(--bg-surface)', borderColor: 'var(--border)', color: 'var(--ink)' },
    modal: { background: 'var(--bg-surface)', borderColor: 'var(--border)', color: 'var(--ink)' },
  },
  list: {
    option: {
      focusBackground: 'var(--bg-hover)',
      selectedBackground: 'var(--accent-soft)',
      selectedFocusBackground: 'var(--accent-soft)',
      color: 'var(--ink)',
      focusColor: 'var(--ink)',
      selectedColor: 'var(--accent-soft-ink)',
      selectedFocusColor: 'var(--accent-soft-ink)',
      icon: { color: 'var(--ink-subtle)', focusColor: 'var(--ink-muted)' },
    },
    optionGroup: { background: 'transparent', color: 'var(--ink-muted)' },
  },
  navigation: {
    item: {
      focusBackground: 'var(--bg-hover)',
      activeBackground: 'var(--bg-hover)',
      color: 'var(--ink)',
      focusColor: 'var(--ink)',
      activeColor: 'var(--ink)',
      icon: { color: 'var(--ink-subtle)', focusColor: 'var(--ink-muted)', activeColor: 'var(--ink-muted)' },
    },
    submenuLabel: { background: 'transparent', color: 'var(--ink-muted)' },
    submenuIcon: { color: 'var(--ink-subtle)', focusColor: 'var(--ink-muted)', activeColor: 'var(--ink-muted)' },
  },
});

// buttons: secondary is the design system's default button (surface, strong border), its
// text variant the ghost button; primary stays the accent
const buttons = {
  root: {
    secondary: {
      background: 'var(--bg-surface)', hoverBackground: 'var(--bg-hover)', activeBackground: 'var(--bg-sunken)',
      borderColor: 'var(--border-strong)', hoverBorderColor: 'var(--border-strong)', activeBorderColor: 'var(--border-strong)',
      color: 'var(--ink)', hoverColor: 'var(--ink)', activeColor: 'var(--ink)',
      focusRing: { color: 'var(--accent)', shadow: 'none' },
    },
  },
  outlined: { secondary: { hoverBackground: 'var(--bg-hover)', activeBackground: 'var(--bg-sunken)', borderColor: 'var(--border-strong)', color: 'var(--ink)' } },
  text: {
    secondary: { hoverBackground: 'var(--bg-hover)', activeBackground: 'var(--bg-sunken)', color: 'var(--ink)' },
    primary: { hoverBackground: 'var(--accent-soft)', activeBackground: 'var(--accent-soft)', color: 'var(--accent)' },
  },
};

// the filter segments (select button): the design system's segmented control
const toggles = {
  root: {
    background: 'var(--bg-surface)', checkedBackground: 'var(--bg-surface)', hoverBackground: 'var(--bg-surface)',
    borderColor: 'var(--border-strong)', checkedBorderColor: 'var(--border-strong)',
    color: 'var(--ink-muted)', hoverColor: 'var(--ink)', checkedColor: 'var(--accent-soft-ink)',
  },
  content: { checkedBackground: 'var(--accent-soft)' },
  icon: { color: 'var(--ink-muted)', hoverColor: 'var(--ink)', checkedColor: 'var(--accent-soft-ink)' },
};

export const DeaPreset = definePreset(Aura, {
  components: {
    togglebutton: { root: { padding: '0.167rem' }, colorScheme: { light: toggles, dark: toggles } },
    button: { root: { label: { fontWeight: '500' } }, colorScheme: { light: buttons, dark: buttons } },
  },
  primitive: {
    borderRadius: { none: '0', xs: '2px', sm: '4px', md: '6px', lg: '10px', xl: '10px' },
  },
  semantic: {
    primary: {
      50: '#eef5ff', 100: '#d9e8ff', 200: '#bcd7ff', 300: '#8ebdff', 400: '#5b9bff',
      500: '#3b7fe8', 600: '#1f63c7', 700: '#1a56ad', 800: '#1a4889', 900: '#1b3d6f', 950: '#14264a',
    },
    focusRing: { width: '2px', style: 'solid', color: 'var(--accent)', offset: '1px', shadow: 'none' },
    formField: { paddingX: '0.75rem', paddingY: '0.375rem', sm: { fontSize: '0.917rem', paddingX: '0.5rem', paddingY: '0.25rem' } },
    list: { option: { padding: '0.5rem 0.75rem' } },
    overlay: {
      select: { shadow: 'var(--shadow-pop)' },
      popover: { shadow: 'var(--shadow-pop)' },
      modal: { shadow: 'var(--shadow-pop)', padding: '1.333rem' },
      navigation: { shadow: 'var(--shadow-pop)' },
    },
    colorScheme: {
      light: scheme({
        0: '#ffffff', 50: '#f7f8fa', 100: '#f1f4f8', 200: '#e1e5ea', 300: '#c9d0d8', 400: '#8a939e',
        500: '#6b7583', 600: '#556070', 700: '#3a4350', 800: '#262c35', 900: '#1b2028', 950: '#0f1216',
      }),
      dark: scheme({
        0: '#ffffff', 50: '#e6e9ee', 100: '#cfd5dd', 200: '#b4bcc7', 300: '#9aa4b2', 400: '#808a99',
        500: '#5f6874', 600: '#3a4350', 700: '#2a313b', 800: '#1f252e', 900: '#161a20', 950: '#0f1216',
      }),
    },
  },
});
