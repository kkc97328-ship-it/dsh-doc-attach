/**
 * Host half of the browser-only document attachment plugin.
 *
 * This module exists so the package has a resolvable ROOT entry, which is what
 * makes it a client package at all. The client-module registry attributes a
 * loader entry to a package by resolving `<entry name>/package.json`, so a row
 * named `dsh-doc-attach/plugins/read-document.mjs` resolves nothing and is
 * recorded as "not a client package" — permanently, since that negative
 * verdict never expires. Only a row whose name IS the bare package name lets
 * the scan find this package's `dsh.client` declaration and its
 * `exports["./client"]` bundle.
 *
 * No host-side behavior lives here: the retrieval tools are registered by
 * `plugins/read-document.mjs` and the upload route by
 * `plugins/drop-ingest.mjs`, each its own row. This mirrors the shipped
 * convention — `@deepseek-ai/dsh-client-ui-attachment`'s host entry is an
 * empty `apply()` for the same reason.
 */

/** No host-side behavior; the client half registers the composer dock entry. */
export function apply() {}
