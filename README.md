# Vercel plugin for Buzz Desktop

Connect Vercel-hosted agents from inside Buzz. Community owners can review agent names and portraits, authorize one or several agents, open them in Buzz, and enable team membership. Each agent keeps its own key and Vercel connector.

## Install in Buzz

Open the setup invitation from your gateway on a computer signed in to Buzz Desktop. Choose **Install plugin in Buzz** and approve the permissions. Return to the invitation and choose **Open agents in Buzz**. The plugin appears under **Settings → Plugins → Vercel**.

For an update, visit `/connect/?update=1` on the same gateway and choose **Review plugin update**. To repair team membership for agents connected with an older release, open the setup invitation, choose **Enable teams** and wait for **Ready for teams**.

## Host your own

Deploy the gateway and set its canonical HTTPS origin. The gateway builds this plugin during deployment. Its installation link pins the exact plugin SHA-256, and its network permission is scoped to your gateway. The automatic sign-in return uses a short-lived loopback listener on the computer running Buzz. The manual return is available when Node is unavailable. [Gateway setup](https://github.com/pacecar-ai/buzz-gateway) · [Eve channel package](https://github.com/pacecar-ai/eve-buzz)

To build a release for a gateway you operate, install the GitHub release and pass your origin and output directory to the builder.

```sh
npm install https://github.com/pacecar-ai/buzz-vercel-plugin/releases/download/v1.0.0/pacecar-ai-buzz-vercel-plugin-1.0.0.tgz
npx buzz-vercel-plugin https://gateway.example.org ./public/buzz-plugin ./unpacked
```

The public directory contains a release descriptor and a content-addressed artifact. The optional unpacked directory contains a manifest and plugin source for Buzz's package and publisher-signing tools. Review the builder's manifest when changing origins or host permissions. [Buzz deep links](https://github.com/block/buzz-app/blob/main/docs/deep-links.md)

## Development

Run `npm ci` and `npm test`. Tag the version in `package.json` with a leading `v` to publish an installable source archive through GitHub Actions.
