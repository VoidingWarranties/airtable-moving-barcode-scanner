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
    on black. A red line, like a scanner laser, crosses each box label in
    view. The image freezes until you accept or reject the box.
-   Finds the box by the `Code` field of the `Containers` table in the
    `Moving + Packing 2026` base. The app loads all boxes when an action
    starts, then turns on the camera.
-   The app fetches the base and the rooms once and keeps them in the local
    storage of the browser. Forget token clears them, so new rooms show.
    It also clears queued updates.
-   Accept sets the `Loaded in van` or `Moved to condo` checkbox of that box.
    To set the `Final Location` of boxes instead, tap Record final location,
    choose a room, then tap Start. The app does not change other
    fields or records.
-   Accept queues the update in the local storage of the browser. Done
    sends the queue to AirTable, 10 boxes per call, and waits until it is
    sent. AirTable rejects a whole call for one missing box, so the app
    then retries those boxes one by one. Updates that fail stay in the
    queue, with the error, and the app beeps and alerts.
-   Queued updates on the action page shows the queue. Submit sends it
    again. Remove drops an update. The queue survives a reload or crash of
    the page.
-   The scanner lists the boxes you accepted, with a count.
-   A scan beeps high. A box that is already in the list on screen gives a
    warning trill instead.
-   The 🔦 button turns the camera light on and off. It shows only when the
    browser can control the light.
-   Show token on the action page shows the saved token. Hide token hides it.
-   The token and action pages show the version, which is the short commit
    SHA. The GitHub Pages workflow sets it, so other copies show `dev`.
    For the workflow to deploy, set the GitHub Pages source of the repository
    to "GitHub Actions".
-   Browsers without native Code 128 detection (e.g. Safari) load the
    [barcode-detector](https://github.com/Sec-ant/barcode-detector) polyfill
    from jsDelivr.
