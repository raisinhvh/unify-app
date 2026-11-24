/**
 * The script file names a pack may ship. Kept free of imports so the registry, publisher and installer share
 * them without pulling in the shim host.
 */

/** Runs after the pack is installed (and from "Run setup again") to do the automatic setup steps. */
export const INSTALL_SCRIPT_NAMES = ['install.js', 'install.ps1', 'install.sh'];

/**
 * Runs when the pack is removed, before its folder is deleted, to undo what the install script put outside the
 * pack folder (a Studio plugin, a Blender add-on, a registry value). The pack folder itself, `data/` included,
 * is deleted by Unify afterwards.
 */
export const UNINSTALL_SCRIPT_NAMES = ['uninstall.js', 'uninstall.ps1', 'uninstall.sh'];

/** Every script a pack may ship, in the order the Hub downloads and publishes them. */
export const PACK_SCRIPT_NAMES = [...INSTALL_SCRIPT_NAMES, ...UNINSTALL_SCRIPT_NAMES];
