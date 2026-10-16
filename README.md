# Box Scanner

A static web app that marks moving boxes in AirTable when you scan their
barcode labels.

## Use

1.  Serve this folder from a static HTTP server. Phones give camera access
    only to HTTPS pages (or `localhost`), so use HTTPS, e.g. GitHub Pages.
2.  Open the page and paste an AirTable personal access token with these
    scopes: `data.records:read`, `data.records:write`, `schema.bases:read`.
    The token stays in the local storage of the browser.
3.  Choose an action. Scan a box, then tap Accept or Reject. Tap Done when
    you have scanned all boxes.

## Behavior

-   Reads only Code 128 barcodes with a value that matches `[A-Z][A-Z][0-9]+`.
    The app ignores all other barcodes. Labels can be black on white or white
    on black.
-   Finds the box by the `Code` field of the `Containers` table in the
    `Moving + Packing 2026` base.
-   Accept sets the `Loaded in van` or `Moved to condo` checkbox of that box.
    The app does not change other fields or records.
-   The 🔦 button turns the camera light on and off. It shows only when the
    browser can control the light.
-   The token and action pages show the version, which is the short commit
    SHA. The GitHub Pages workflow sets it, so other copies show `dev`.
    For the workflow to deploy, set the GitHub Pages source of the repository
    to "GitHub Actions".
-   Browsers without native Code 128 detection (e.g. Safari) load the
    [barcode-detector](https://github.com/Sec-ant/barcode-detector) polyfill
    from jsDelivr.
