'use strict';
/* The only file in this project that knows what the product is called.
 *
 * Every other module asks this one. Window titles, the title bar, the about
 * panel, generated report headers, the desktop shortcut and the icon filenames
 * all read from here, so renaming the product is a one-line change rather than
 * a rename across the tree.
 *
 * This is enforced, not merely intended: tests/run-all.js greps every source
 * file for the product name and fails if it appears anywhere except this file.
 * A name compiled into two hundred strings is how a codebase becomes impossible
 * to rebrand, and how a working name ends up shipped by accident.
 */

const NAME = 'VANTAGE';

module.exports = {
  /* Shown in the title bar, the taskbar and the about panel. */
  name: NAME,

  /* Window title. Kept as a function because instrument workspaces append the
     selected symbol and the caller should not be assembling the separator. */
  windowTitle(suffix) {
    return suffix ? NAME + '  ·  ' + suffix : NAME;
  },

  /* The credit line in the status bar.
   *
   * This is a product credit and deliberately not a data-provenance claim. The
   * provider behind any individual figure is named in the sources drawer, which
   * reads from the provenance record attached to that figure and nowhere else.
   * Wording that implied these two names supplied the market data would be a
   * claim the application cannot support. */
  credit: 'Powered by SYRIX · Kabirr Wealth Partners',

  /* Attribution. Shown in the about panel and in the window's own metadata, so
     the application says who built it wherever it is looked at properly. */
  author: 'Kabirr Kohli',
  attribution: 'Made by Kabirr Kohli',

  /* Sent to every upstream so a source that wants to identify or block this
     client can do so. See src/core/http.js for why this is not a browser
     string. The contact route is required by SEC EDGAR's access policy and is
     good manners everywhere else; it is read from VANTAGE_CONTACT so no address
     is committed to the source. */
  userAgent: 'Vantage/0.1 (single-user research terminal; contact ' +
    (process.env.VANTAGE_CONTACT || 'not configured') + ')',

  /* Filename stem for generated icons, so the shortcut and the window icon
     cannot drift apart. */
  iconStem: 'vantage'
};
