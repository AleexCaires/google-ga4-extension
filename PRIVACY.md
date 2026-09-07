# Conversio DataSpy: Privacy Policy

Last updated: 7 September 2026

Conversio DataSpy is a developer tool for checking that analytics tracking
works correctly on a website. This policy explains what the extension reads,
where that information goes, and what it never does.

## The short version

Everything the extension reads stays in your browser. Nothing is sent to
Conversio or to anyone else. There are no accounts, no servers and no
analytics on the extension itself.

## What the extension reads

When you open the panel on a tab, the extension reads the following from that
tab only:

- Outgoing Google Analytics 4 requests, including the event name and the
  parameters being sent
- The URL and title of the page, so events can be grouped by page
- Pushes the page makes to its `dataLayer`
- A fixed set of Conversio values in the page's `sessionStorage` and
  `localStorage`, used to check that events match what the page recorded
- The domains of A/B testing tools the page loads, so the tool can be named in
  the panel

It reads this to display it back to you. It does not read page content beyond
the items listed above, and it does not inject anything into the page.

## Where the information goes

Captured events are held in `chrome.storage.session`, which is local to your
browser and cleared when the browser session ends. You can clear it at any
time with the Clear button.

No information is transmitted off your device. The extension makes no network
requests of its own. It has no back end.

## What the extension never does

- It does not sell or share your data with third parties
- It does not use your data for advertising or profiling
- It does not use your data to determine creditworthiness or for lending
- It does not track you across sites, or record anything about your browsing
  outside the tab you are debugging
- It does not collect names, email addresses, passwords, payment details or
  any other personal or authentication information

## Cookies

The Clear button in the Conversio Storage section deletes cookies for the
domain of the tab you are debugging. This exists so a tester can reset a
session and re-test tracking from a clean state. Cookie values are not read,
stored or transmitted, and no other domain is affected. Nothing is deleted
unless you press the button.

## Why the extension needs broad site access

Analytics requests can be sent to any domain. Sites using server-side tagging
send them to their own first-party domain, which cannot be known in advance.
The extension therefore needs permission to observe requests on whichever site
you are testing. That access is used only for the purposes described above.

## Blocking A/B testing tools

The panel offers an optional toggle that blocks one A/B testing tool's requests
so you can compare the page with and without it. This applies only to the tab
you are debugging, lasts for the browser session, and is removed when you
switch it off or close the tab.

## Changes to this policy

Any change will be published on this page with a new date above.

## Contact

Questions about this policy: alex@conversio.com
