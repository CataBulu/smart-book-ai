"""Selenium end-to-end tests for the Smart Book AI front end.

They drive a real Chrome against a running app, by default the fake-LLM Docker container:
    docker compose --profile test up -d smartbook-test       # http://localhost:8081 (from the repo root)
    uv run pytest                                            # from selenium-tests/
SMARTBOOK_URL points them at another server; HEADED=1 shows the browser. A failing test leaves a screenshot and the
page HTML in selenium-tests/artifacts/.
"""

import json
import os
import re
import time
import urllib.request
from pathlib import Path

import pytest
from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support.ui import WebDriverWait

BASE_URL = os.environ.get("SMARTBOOK_URL", "http://127.0.0.1:8081").rstrip("/")
ARTIFACTS = Path(__file__).with_name("artifacts")
TIMEOUT = 20
SEED_BOOKS = 60
RUN = time.strftime("%H%M%S")  # suffix for books a test adds, so the suite can run again on the same server
FAILED = pytest.StashKey[bool]()


def api(method: str, path: str, body: dict | None = None) -> dict:
    """Call the app's API directly, to set up data a test needs without clicking through the UI."""
    req = urllib.request.Request(BASE_URL + "/api" + path, method=method, headers={"Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or "null")


def lit(text: str) -> str:
    """An XPath string literal for any text, including one with both kinds of quote."""
    if "'" not in text:
        return f"'{text}'"
    if '"' not in text:
        return f'"{text}"'
    return "concat(" + ", \"'\", ".join(f"'{part}'" for part in text.split("'")) + ")"


# Native HTML5 drag-and-drop: Selenium's ActionChains can't start one in Chrome, so the events are dispatched the way
# the browser would, with one shared DataTransfer and a pause after each so React can re-render in between.
DRAG_JS = """
const [source, target, done] = arguments;
const data = new DataTransfer();
const fire = (el, type) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: data,
                                        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}));
};
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
(async () => {
  fire(source, 'dragstart'); await pause(80);
  fire(target, 'dragenter'); fire(target, 'dragover'); await pause(300);  // the others glide aside
  // the dragged item now sits under the pointer, so that's where a real drop lands
  fire(source, 'dragover'); fire(source, 'drop'); fire(source, 'dragend'); await pause(80);
  done();
})();
"""

# Set a long value the way typing would (React only hears the 'input' event), without typing it key by key.
SET_VALUE_JS = """
const [el, value] = arguments;
const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
el.dispatchEvent(new Event('input', {bubbles: true}));
"""


class UI:
    """Small helpers that find things by what a person sees: button names, labels, test ids and text."""

    def __init__(self, driver: webdriver.Chrome):
        self.d = driver

    # --- waiting ------------------------------------------------------------------------------------------------
    def wait(self, condition, what: str, timeout: float = TIMEOUT):
        def safe(d):
            try:
                return condition(d)
            except StaleElementReferenceException:  # React re-rendered under us: just look again
                return None
        return WebDriverWait(self.d, timeout, poll_frequency=0.1).until(safe, f"Timed out waiting for {what}")

    def until(self, check, what: str, timeout: float = TIMEOUT):
        """Wait until check() is truthy (for assertions on text, counts, attributes)."""
        return self.wait(lambda _: check(), what, timeout)

    # --- finding ------------------------------------------------------------------------------------------------
    def find(self, selector: str, root=None, visible: bool = True) -> WebElement:
        def first(d):
            for el in (root or d).find_elements(By.CSS_SELECTOR, selector):
                if not visible or el.is_displayed():
                    return el
            return None
        return self.wait(first, f"element {selector!r}")

    def all(self, selector: str, root=None) -> list[WebElement]:
        return (root or self.d).find_elements(By.CSS_SELECTOR, selector)

    def visible(self, selector: str, root=None) -> list[WebElement]:
        return [el for el in self.all(selector, root) if el.is_displayed()]

    @staticmethod
    def tid(test_id: str) -> str:
        return f'[data-testid="{test_id}"]'

    def button(self, name: str, exact: bool = True, root=None) -> WebElement:
        """A visible button (or tab/switch/link-button) by its accessible name: its text or its aria-label."""
        if exact:
            cond = f"normalize-space(.)={lit(name)} or @aria-label={lit(name)}"
        else:
            cond = f"starts-with(normalize-space(.), {lit(name)}) or starts-with(@aria-label, {lit(name)})"
        xpath = f".//*[(self::button or @role='tab' or @role='switch') and ({cond})]"

        def first(d):
            return next((el for el in (root or d).find_elements(By.XPATH, xpath) if el.is_displayed()), None)
        return self.wait(first, f"button {name!r}")

    def click(self, name: str, exact: bool = True, root=None) -> WebElement:
        btn = self.button(name, exact, root)
        self.until(btn.is_enabled, f"button {name!r} to be enabled")
        btn.click()
        return btn

    def field(self, label: str, root=None) -> WebElement:
        """An input, textarea or select by its aria-label or <label> text (exact first, then 'starts with')."""
        xpaths = (f".//*[@aria-label={lit(label)}][self::input or self::textarea or self::select]",
                  f".//label[normalize-space(.)={lit(label)}]",
                  f".//label[starts-with(normalize-space(.), {lit(label)})]")

        def first(d):
            for xpath in xpaths:
                for el in (root or d).find_elements(By.XPATH, xpath):
                    if el.tag_name == "label":
                        target = el.get_attribute("for")
                        el = d.find_element(By.ID, target) if target else el.find_element(By.XPATH, ".//input|.//textarea")
                    if el.is_displayed():
                        return el
            return None
        return self.wait(first, f"field {label!r}")

    def text_el(self, text: str, root=None) -> WebElement:
        """The innermost visible element whose text contains `text`."""
        xpath = f".//*[contains(normalize-space(.), {lit(text)}) and not(*[contains(normalize-space(.), {lit(text)})])]"

        def first(d):
            return next((el for el in (root or d).find_elements(By.XPATH, xpath) if el.is_displayed()), None)
        return self.wait(first, f"text {text!r}")

    def dialog(self, name: str, exact: bool = False, role: str = "dialog") -> WebElement:
        """A dialog by its aria-label or its heading text."""
        def first(d):
            for el in d.find_elements(By.CSS_SELECTOR, f'[role="{role}"]'):
                label = el.get_attribute("aria-label") or ""
                if not label and el.get_attribute("aria-labelledby"):
                    label = d.find_element(By.ID, el.get_attribute("aria-labelledby")).text
                if el.is_displayed() and (label == name if exact else label.startswith(name)):
                    return el
            return None
        return self.wait(first, f"{role} {name!r}")

    # --- doing --------------------------------------------------------------------------------------------------
    def fill(self, label_or_el, text: str, root=None) -> WebElement:
        el = self.field(label_or_el, root) if isinstance(label_or_el, str) else label_or_el
        el.send_keys(Keys.CONTROL, "a")
        el.send_keys(Keys.DELETE)
        if len(text) > 200 or "\n" in text:
            self.d.execute_script(SET_VALUE_JS, el, text)
        else:
            el.send_keys(text)
        return el

    def drag(self, source: WebElement, target: WebElement) -> None:
        self.d.execute_async_script(DRAG_JS, source, target)

    def hover(self, el: WebElement) -> WebElement:
        ActionChains(self.d).move_to_element(el).perform()
        return el

    def press(self, *keys: str) -> None:
        """Keys sent to the page (the reader and dialogs listen on the window)."""
        ActionChains(self.d).send_keys(*keys).perform()

    def toast(self, text: str) -> WebElement:
        return self.text_el(text, root=self.find(".toasts", visible=False))

    # --- the app ------------------------------------------------------------------------------------------------
    def open(self, path: str = "/") -> "UI":
        self.d.get(BASE_URL + path)
        self.until(lambda: self.book_count() >= SEED_BOOKS, "the seeded library")
        return self

    def reload(self) -> "UI":
        self.d.refresh()
        self.until(lambda: self.book_count() >= SEED_BOOKS, "the library after reload")
        return self

    def book_count(self) -> int:
        counts = self.all(self.tid("book-count"))  # in the sidebar, which is hidden on phones: read the DOM text
        text = counts[0].get_attribute("textContent").strip() if counts else ""
        return int(text) if text.isdigit() else 0

    def theme(self) -> str:
        return self.d.find_element(By.TAG_NAME, "html").get_attribute("data-theme")

    def answers(self) -> list[WebElement]:
        return self.all(self.tid("assistant-message"))

    def last_answer(self) -> WebElement:
        return self.answers()[-1]

    def ask(self, text: str) -> WebElement:
        """Send a chat message and wait until its answer has finished streaming."""
        before = len(self.answers())
        self.fill("Message", text).send_keys(Keys.ENTER)
        return self.answer_after(before)

    def answer_after(self, before: int) -> WebElement:
        self.until(lambda: len(self.answers()) > before, "an answer to appear")
        self.until(lambda: not self.all(".typing, .thinking", self.last_answer())
                   and self.visible('button[aria-label="Send"]'), "the answer to finish streaming")
        return self.last_answer()

    def go_library(self) -> None:
        self.click("Library", exact=False)
        self.button("Add books")

    def book_card(self, title: str) -> WebElement:
        def card(d):
            for el in d.find_elements(By.CSS_SELECTOR, self.tid("book-card")):
                if el.is_displayed() and el.find_element(By.TAG_NAME, "p").text == title:
                    return el
            return None
        return self.wait(card, f"book card {title!r}")

    def open_book(self, title: str) -> WebElement:
        self.go_library()
        self.fill("Search library", title)
        self.book_card(title).click()
        return self.dialog(title, exact=True)

    def grid_titles(self) -> list[str]:
        return [el.find_element(By.TAG_NAME, "p").text for el in self.all(self.tid("grid-item"))]

    def requests_to(self, path_end: str) -> list[dict]:
        """Requests the page sent to a URL ending in `path_end` (from Chrome's performance log)."""
        found = []
        for entry in self.d.get_log("performance"):
            msg = json.loads(entry["message"])["message"]
            if msg.get("method") == "Network.requestWillBeSent" and msg["params"]["request"]["url"].endswith(path_end):
                found.append(msg["params"]["request"])
        return found


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item, call):
    report = yield
    if report.failed:
        item.stash[FAILED] = True
    return report


def make_driver(width: int = 1280, height: int = 900) -> webdriver.Chrome:
    opts = webdriver.ChromeOptions()
    if not os.environ.get("HEADED"):
        opts.add_argument("--headless=new")
    for arg in (f"--window-size={width},{height}", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                "--no-first-run", "--disable-search-engine-choice-screen", "--disable-dev-shm-usage"):
        opts.add_argument(arg)
    if os.environ.get("CI"):
        opts.add_argument("--no-sandbox")
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    return webdriver.Chrome(options=opts)


@pytest.fixture
def driver(request):
    drv = make_driver()
    yield drv
    if request.node.stash.get(FAILED, False):
        ARTIFACTS.mkdir(exist_ok=True)
        name = re.sub(r"[^\w-]+", "_", request.node.name)
        drv.save_screenshot(str(ARTIFACTS / f"{name}.png"))
        (ARTIFACTS / f"{name}.html").write_text(drv.page_source, encoding="utf-8")
    drv.quit()


@pytest.fixture
def ui(driver) -> UI:
    return UI(driver).open()


@pytest.fixture
def files(tmp_path):
    """Write files for upload inputs: files(name=content, ...) -> their paths, joined the way send_keys wants."""
    def make(*named: tuple[str, str | bytes]) -> str:
        paths = []
        for name, content in named:
            path = tmp_path / name
            path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
            paths.append(str(path))
        return "\n".join(paths)
    return make
