# Windows test

A hands-on check of Clueless on a real Windows 11 PC. About 40 minutes. Do the whole list twice:
once at **100%** display scaling and once at **150%** (Settings → System → Display → Scale).
Then send the filled-in table back, with a screenshot (Win + Shift + S) of anything that looks wrong.

## Before you start

- **Clueless must be live** (Ali runs `scripts/go-live.sh` first), or there's nothing to sign in to.
- **The installer:** (you need to be signed in to GitHub to download it) on GitHub, open the repo's **Actions** tab → the latest green **Tests** run on
  `plan/final-product` → **Artifacts** → `Clueless-Setup-windows`. Unzip it to get `Clueless-Setup.exe`.
  (Once Clueless has a public release, the website's Download for Windows button works instead.)
- **An invite code**, from Ali.
- **Something to test with:** a math problem open in a browser tab, plus this Python code pasted into
  Notepad and into VS Code:
  ```python
  def bubble(a):
      for i in range(len(a)):
          for j in range(len(a) - 1 - i):
              if a[j] > a[j + 1]:
                  a[j], a[j + 1] = a[j + 1], a[j]
      return a
  ```

## The checks

Mark each one ✓ (works), ✗ (broken: say what happened) or – (couldn't try).

| # | Do this | You should see | 100% | 150% | Notes |
|---|---|---|---|---|---|
| 1 | Run `Clueless-Setup.exe`. If Windows says **Windows protected your PC**, click **More info → Run anyway**. Finish the installer. | It installs, opens, and the Clueless icon appears near the clock (maybe under the **^** arrow). | | | |
| 2 | Left-click the tray icon, then left-click it again. Then right-click it. | The panel shows, then hides. Right-click opens a menu listing the shortcuts. | | | |
| 3 | Sign in with Google. | A browser tab opens, then says "You're signed in". The panel asks for an invite code. | | | |
| 4 | Enter the invite code, tick 18 or older, click Start. | The welcome screen: Screen Recording and Accessibility already ticked. Allow the Microphone if asked. | | | |
| 5 | Click **Try it on a sample problem**. | Clueless asks what's tripping you up about the derivative. | | | |
| 6 | Open your math problem in the browser, press **Ctrl + Shift + Space**. | The panel opens and Clueless talks about *that* problem. | | | |
| 7 | Press **Ctrl + Shift + 2** and drag a box around just the problem. | The box follows your mouse exactly (check this at 150%), and the reply is about what was in the box. | | | |
| 8 | Put the browser in full screen (**F11**), press **Ctrl + Shift + Space**. Repeat over a full-screen YouTube video. | The panel appears on top of the full-screen page. | | | |
| 9 | Press **Ctrl + Shift + 3**. Then highlight a sentence in the browser, in Notepad, in VS Code and in Word (if you have it). | The island shows. After each highlight, **Ask** and **Animate** buttons appear next to the mouse. | | | |
| 10 | Copy something of your own (Ctrl + C on any text), highlight text somewhere else, then paste (Ctrl + V) into Notepad. | You paste *your* text: Clueless put your clipboard back. | | | |
| 11 | **The terminal check.** In Windows Terminal (or PowerShell) run `ping -t localhost`, which keeps going. While it runs, drag-select some of its text. Then drag across an empty part of the window. | `ping` keeps running both times. If it stops with `^C`, that's a ✗. | | | |
| 12 | Same as 11 in the old **Command Prompt** (cmd.exe). | `ping` keeps running. | | | |
| 13 | In VS Code, highlight the `bubble` function and click **Animate**. | The steps play in the visual island, and the line that's running glows on the real line in VS Code, lined up exactly. | | | |
| 14 | Do 13 again with VS Code on a second monitor, if you have one (best if its scaling is different). | The glow still sits on the right line. | | | |
| 15 | Click **Ask** on a highlighted sentence. | A short explanation shows in the panel. | | | |
| 16 | Press **Ctrl + Shift + 1** (or the mic button) and say a short answer, then pause. | Your words appear as you speak, then are sent. | | | |
| 17 | Turn on **Read replies aloud** (Settings). Ask anything. | The reply is read aloud in the computer's voice. | | | |
| 18 | In **Settings → Shortcuts**, click *Read my screen* and press **Ctrl + Alt + K**. Try the new shortcut, then the old one. | The new one reads the screen; the old one does nothing. The tray menu shows the new one. | | | |
| 19 | Open **History**, open today's session, click **Continue where I left off**. | The old conversation is back, and Clueless picks up where you stopped. | | | |
| 20 | Quit Clueless from the tray menu, open it again from the Start menu. | You're still signed in. Your shortcut from 18 is still set. | | | |
| 21 | Settings → Apps → Installed apps → Clueless → Uninstall. | It uninstalls cleanly. | | | |

## Also note

- Your Windows version (Settings → System → About), your screen size, and whether you have a second monitor.
- Anything slow (over about 20 seconds for a reply), blurry, cut off or in the wrong place.
- Antivirus or firewall warnings, with a screenshot.
