# Privacy and permissions

Live Dub is a personal, bring-your-own-key Chrome extension. It has no analytics, advertising, developer-operated backend, or account system.

## Information handled

- **Selected tab audio:** after you click Start, the tab's audio goes directly to OpenAI for speech translation. This includes any ads or other audible material in that tab. The extension does not capture your microphone or other tabs.
- **OpenAI API key:** stored in local extension storage (`chrome.storage.local`) on this computer so you don't have to re-enter it, and never in Chrome Sync. Only trusted extension contexts have access. The service worker sends it to OpenAI to obtain a short-lived client token; the audio document receives only that token. The key is not injected into websites. It stays saved across browser restarts until you click Forget key (which also stops translation) or uninstall the extension. Local extension storage is not encrypted, so anyone with access to your computer's browser profile could read it.
- **English transcript:** a rolling excerpt of about 1,600 characters is held in session memory for the popup. Stop clears it. The extension does not write transcript or audio files.
- **Preferences:** source language, voice, mode, and volume levels are saved in local extension storage.
- **Current session:** selected tab ID/title and connection status are held in session memory. They are not included in the translation request.

OpenAI independently processes transmitted audio under its API data policies: https://platform.openai.com/docs/guides/your-data. This extension's lack of local recordings does not imply that a provider retains no data.

## Chrome permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the tab you explicitly invoke the extension on. |
| `tabCapture` | Capture that tab's audio after Start. |
| `offscreen` | Keep capture and playback running when the popup closes. |
| `storage` | Store preferences, your saved API key, and session state. |
| `https://api.openai.com/*` | Obtain session tokens and negotiate audio connections with OpenAI. |

No content script, microphone capture, browsing-history access, or website DOM scraping is used.

## Stopping and removing data

Click Stop to close the audio connection and release capture. Closing the popup alone does not stop translation or API usage. Forget key also removes the credential. Uninstall the extension to remove its stored preferences and key.

## Shared deployments

Do not embed a shared API key in a public extension. A hosted product should use its own authenticated backend to issue short-lived client tokens. This package is designed for each user to supply their own key.
