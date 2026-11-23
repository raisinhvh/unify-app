/**
 * Shared components. Screens build only from these plus motion/ and theme tokens.
 *
 *   Button, IconButton     text / primary (#EFE6DA, 6px) / secondary / row / ghost; elastic press; no pills
 *   Icon, icons            Figma icon set (16px, currentColor)
 *   Popover                anchored, flips, Pop in, closes on outside click / Escape
 *   Menu                   groups, checks, hints, keyboard
 *   Select                 text button + Menu
 *   Tooltip / TooltipHost  tooltip(el, content) ref helper; one host in App
 *   Toggle                 flat switch on the Control spring
 *   TreeFolder, TreeItem   file-system tree with guide lines, chevron spring, Collapse
 *   UsageMeter             rail usage meter (the rail itself is shell/NavRail)
 *   TitleBar               frameless window controls
 *   loaders/               15 action loaders with morphing
 */
export { Button, IconButton, type ButtonProps, type ButtonVariant, type IconButtonProps } from './Button';
export { Icon, type IconProps } from './Icon';
export { icons, type IconName } from './icons';
export { Popover, type PopoverPlacement, type PopoverProps } from './Popover';
export { Menu, type MenuEntry, type MenuProps } from './Menu';
export { Select, type SelectOption, type SelectProps } from './Select';
export { tooltip, TooltipHost, type TooltipOptions } from './Tooltip';
export { Toggle, type ToggleProps } from './Toggle';
export { TreeFolder, TreeItem, type TreeFolderProps, type TreeItemProps } from './Tree';
export { UsageMeter } from './UsageMeter';
export { ProviderGlyph, providerGlyph, providerGlyphs, type ProviderGlyphName, type ProviderGlyphProps } from './ProviderGlyph';
export { ModelPicker, type ModelPickerProps, type ModelPickerVariant } from './ModelPicker';
export { TitleBar } from './TitleBar';
export * from './loaders';
