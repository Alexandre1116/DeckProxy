# DeckProxy

**CLIProxyAPI on your Stream Deck.** Keep an eye on remaining usage and request counts without leaving your desk.

DeckProxy is a Stream Deck plugin for CLIProxyAPI. Add an action to a key, choose your account or request period, and refresh it with a press.

## Download and install

1. Download `DeckProxy-v3.5.streamDeckPlugin` from the [latest release](https://github.com/Alexandre1116/DeckProxy/releases/latest).
2. Open the downloaded file on a Windows or macOS computer with Stream Deck **7.6 or later**.
3. In the Stream Deck app, drag an action from **DeckProxy** onto a key.
4. Enter your CLIProxyAPI address and management key, then select **Test connection**. Settings save automatically.

Use an address reachable from the computer running Stream Deck. For a proxy on another machine, `localhost` refers to the Stream Deck computer. Remote management must be enabled on the proxy when connecting remotely.

## Actions

### Usage remaining

Select an account to show its available usage windows. The key can display a short window, such as five hours or one day, alongside a weekly window when the provider supplies them.

- Set the normal, medium and low colors, background, and percentage thresholds.
- Enable blinking at the low threshold.
- Press the key to refresh. A green check confirms success, and an alert indicates a failed refresh.
- Quota refreshes automatically every two minutes. A `STALE` indicator marks the last known values after a temporary failure.

The plugin queries Codex, Claude, Kimi and xAI usage through CLIProxyAPI. Other providers require a compatible quota provider configured in CLIProxyAPI. Availability and time windows depend on the account, provider, proxy version and installed quota providers. A missing value is shown as unavailable.

### Requests

Choose the current hour, day, week or month. Customize the text, accent and background colors, and choose whether to show the period on the key.

Enable **Collect requests from the queue** to count requests. The plugin reads the proxy's usage queue every 15 seconds and stores counts locally on the Stream Deck computer. Enable usage statistics in CLIProxyAPI as well. Counts cover records collected by the plugin while it is running. Reading the queue removes records, so other consumers of the same queue may miss them.

## Connection and storage

DeckProxy uses the CLIProxyAPI management API and its management key. The Stream Deck app stores the shared connection settings, including the management key. Request counts are stored in `~/.cliproxy-streamdeck/counts.sqlite` on the computer running the plugin.

## Build from source

The source is in [`pt.cli-proxy.monitor.sdPlugin`](pt.cli-proxy.monitor.sdPlugin). With Node.js and the [Stream Deck CLI](https://docs.elgato.com/streamdeck/cli/overview/) installed, run:

```sh
streamdeck pack pt.cli-proxy.monitor.sdPlugin
```

The manifest targets the Stream Deck Node.js 24 runtime.

## Version history

The original v1.0 source is preserved in the `v1.0` Git tag, and its original installer is in [`versions`](versions/). The latest GitHub release is v3.5. The current source includes the v3.6 Marketplace package with SDK 3 support. The intermediate installers were overwritten during development and are unavailable. The original v1.0 interface is in Portuguese.

## License

DeckProxy is licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](LICENSE) (CC BY-NC-SA 4.0).
