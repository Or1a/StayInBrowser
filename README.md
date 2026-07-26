# StayInBrowser

[中文](#中文) · [English](#english)

## 中文

一个跨浏览器 Userscript，用于阻止网页唤醒或打开外部 App，并尽量将网页导航保留在当前浏览器中。

### 支持环境

- iOS、iPadOS 和 macOS Safari，搭配 [Userscripts（App Store）](https://apps.apple.com/app/userscripts/id1463298887)
- Chrome、Edge 和 Firefox，搭配 Tampermonkey 或 Violentmonkey
- 其他支持 `@grant none` 与 `document-start` 的 Userscript 环境

不同脚本管理器的页面注入方式可能影响部分拦截功能。

### 功能

- 默认只允许 `http:` 和 `https:`，阻止自定义 App URL Scheme
- 拦截点击、触摸和键盘触发的 App 唤醒
- 拦截常见网页导航 API、动态链接、表单、iframe、`object` 和 `embed`
- 识别没有 `href`、仅靠 JavaScript 点击处理器唤醒 App 的控件
- 对跨域网页导航使用隔离中转，并将目标作为顶层网页加载
- 监控普通 DOM、Shadow DOM 和同源 iframe 中动态生成的导航入口
- 默认阻止网页注册新的自定义协议处理器
- 对常见移动端网页链接进行保守规范化
- 提供可选调试日志和只读诊断接口
- 无外部依赖，不上传数据，不采集浏览记录

### 安装

1. Safari 用户从 App Store 安装 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)；其他浏览器用户安装适合当前浏览器的脚本管理器。
2. 打开 [`StayInBrowser.user.js`](https://raw.githubusercontent.com/Or1a/StayInBrowser/main/StayInBrowser.user.js)。
3. 在脚本管理器中确认安装；Safari Userscripts 用户也可以将文件保存到所选脚本目录。
4. 授予脚本管理器访问目标网站的权限。
5. 启用脚本并重新载入已打开的网页。

### 配置

所有配置都集中在脚本顶部：

```javascript
const CONFIG = {
  enabled: true,
  debug: false,
  forceSameTab: true,
  blockMailto: true,
  blockTelephone: true,
  blockUniversalLinks: true,
  blockProtocolHandlerRegistration: true,
  applySiteCompatibilityHints: true,
  relayCrossOriginNavigation: true,
  showBlockedToast: false,
  allowedSchemes: ['http:', 'https:'],
  allowedHosts: [],
  blockedHosts: [],
};
```

如需查看详细日志，将 `debug` 改为 `true`。日志前缀为 `[StayInBrowser]`。网页控制台还可使用：

```javascript
StayInBrowser.getStats()
StayInBrowser.resetStats()
StayInBrowser.enable()
StayInBrowser.disable()
```

### 快速验证

在网页控制台运行：

```javascript
window.open('myapp://example')
```

调用应返回 `null`，且不会打开对应的外部 App。随后运行：

```javascript
StayInBrowser.getStats()
```

`interceptedWindowOpen` 和 `blockedCustomSchemes` 应增加。

### 重要限制

Userscript 可以阻止网页层面的点击、自定义 URL Scheme、JavaScript 唤醒和部分可取消的客户端重定向，并通过隔离中转处理捕获到的跨域网页导航。但它无法控制操作系统或浏览器在页面 JavaScript 执行范围之外处理的 Universal Link、Intent、浏览器界面操作、服务器端重定向或系统级 App Banner，因此不能保证 100% 阻止所有 App 唤醒。

多数浏览器不允许网页脚本可靠地重新定义 `window.location`、`location.href` 或 `top.location` 等原生属性。如果脚本无法从点击控件推断目标，也无法取消随后发生的导航，直接赋值触发的跳转仍可能绕过拦截。

若登录、支付或其他流程必须使用新窗口，可将 `forceSameTab` 改为 `false`，或临时运行 `StayInBrowser.disable()`。

---

## English

A cross-browser Userscript that blocks websites from launching external apps and tries to keep web navigation in the current browser.

### Supported environments

- Safari on iOS, iPadOS, and macOS with [Userscripts (App Store)](https://apps.apple.com/app/userscripts/id1463298887)
- Chrome, Edge, and Firefox with Tampermonkey or Violentmonkey
- Other Userscript environments supporting `@grant none` and `document-start`

Page-injection behavior varies between script managers and may affect some interception features.

### Features

- Allows only `http:` and `https:` by default and blocks custom app URL schemes
- Blocks app-launch attempts triggered by click, touch, and keyboard events
- Intercepts common navigation APIs, dynamic links, forms, iframes, `object`, and `embed`
- Detects app-launch controls that have no `href` and rely on JavaScript click handlers
- Uses an isolated relay for cross-origin navigation and loads the destination as a top-level page
- Monitors navigation targets created in the DOM, Shadow DOM, and same-origin iframes
- Blocks new custom protocol-handler registration by default
- Conservatively normalizes common mobile web links
- Includes optional debug logging and a read-only diagnostics interface
- Has no external dependencies, sends no data, and collects no browsing history

### Installation

1. Safari users can install [Userscripts from the App Store](https://apps.apple.com/app/userscripts/id1463298887); users of other browsers should install a compatible script manager.
2. Open [`StayInBrowser.user.js`](https://raw.githubusercontent.com/Or1a/StayInBrowser/main/StayInBrowser.user.js).
3. Confirm the installation in your script manager. Safari Userscripts users can also save the file in their selected scripts directory.
4. Allow the script manager to access the sites you want to protect.
5. Enable the script and reload any pages that are already open.

### Configuration

All options are grouped in `CONFIG` near the top of the script. Set `debug: true` for detailed `[StayInBrowser]` console logs. The following diagnostic methods are also available:

```javascript
StayInBrowser.getStats()
StayInBrowser.resetStats()
StayInBrowser.enable()
StayInBrowser.disable()
```

Set `forceSameTab: false` if a login, payment, or other workflow legitimately requires a new window.

### Quick verification

Run this in a page console:

```javascript
window.open('myapp://example')
```

It should return `null` without opening the corresponding external app. Then check:

```javascript
StayInBrowser.getStats()
```

Both `interceptedWindowOpen` and `blockedCustomSchemes` should increase.

### Important limitations

This Userscript can block page-level clicks, custom URL schemes, JavaScript app-launch attempts, and some cancelable client redirects. It also handles captured cross-origin web navigation through an isolated relay. It cannot control Universal Links, intents, browser UI actions, server-side redirects, or system app banners handled outside the page’s JavaScript context, so it cannot guarantee that every app launch will be blocked.

Browsers normally prevent page scripts from reliably redefining native properties such as `window.location`, `location.href`, and `top.location`. A direct assignment may still bypass interception when the script cannot infer its target from the clicked control or cancel the resulting navigation.
