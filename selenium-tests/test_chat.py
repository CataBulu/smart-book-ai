import json
import re

from selenium.webdriver.common.keys import Keys


def test_mood_chip_gets_a_grounded_answer_with_book_cards(ui):
    before = len(ui.answers())
    ui.click("Short reads")
    answer = ui.answer_after(before)
    assert "short book" in ui.find(ui.tid("user-message")).text
    assert ui.all(ui.tid("pick"), answer), "the answer shows book cards"
    assert ui.all(".prose strong", answer), "the answer names books"
    ui.click("Details", root=answer)
    assert re.search(r"tokens · \$", ui.find(ui.tid("details"), answer).text)
    assert "A short book" in ui.find('.recent-row[aria-current="page"]').text
    assert ui.find(ui.tid("session-cost")).text != "$0.0000"


def test_follow_up_is_rewritten_using_the_conversation(ui):
    ui.ask("gothic mystery about jealousy at an estate")
    answer = ui.ask("something like that but shorter?")
    ui.click("Details", root=answer)
    ui.until(lambda: "gothic mystery about jealousy" in ui.find(ui.tid("details"), answer).text,
             "the rewritten query in Details")


def test_illustrate_a_book_and_listen_to_the_answer(ui):
    answer = ui.ask("solitude nature cabin pond")
    ui.click("Illustrate", root=ui.find(ui.tid("pick"), answer))
    ui.until(lambda: "/api/media/images/" in (ui.find(".illustration img", answer).get_attribute("src") or ""),
             "the painted illustration")
    ui.d.get_log("performance")  # start the request log from here
    ui.click("Listen", root=answer)
    sent = []
    ui.until(lambda: sent.extend(ui.requests_to("/api/tts")) or sent, "the speech request")
    assert json.loads(sent[0]["postData"])["voice"] == "af_heart"


def test_dictation_fills_the_message_box(ui):
    ui.click("Speak your request")
    ui.click("Stop recording")
    ui.until(lambda: ui.field("Message").get_attribute("value") == "books about the sea", "the transcription")


def test_new_conversation_and_reopening_one_from_the_sidebar(ui):
    ui.ask("desert planet science fiction epic")
    ui.click("New conversation")
    ui.until(lambda: len(ui.visible(".mood")) == 8, "the home screen")
    ui.text_el("desert planet", root=ui.find(".recent")).click()
    ui.until(lambda: len(ui.answers()) == 1, "the conversation to reopen")
    assert "desert planet" in ui.find(ui.tid("user-message")).text


def test_deleting_a_conversation_asks_for_confirmation(ui):
    ui.ask("lighthouse keeper on a stormy island")
    row = ui.text_el("lighthouse keeper", root=ui.find(".recent"))
    ui.hover(row)
    ui.click("Delete “lighthouse keeper", exact=False)
    confirm = ui.dialog("Delete conversation?", role="alertdialog")
    assert "Are you sure you want to delete “lighthouse keeper on a stormy island”?" in confirm.text
    assert ui.d.switch_to.active_element == ui.button("Cancel", root=confirm)
    ui.press(Keys.ESCAPE)
    ui.until(lambda: not ui.visible('[role="alertdialog"]'), "the confirmation to close")
    assert "lighthouse keeper" in ui.find(".recent").text

    ui.hover(ui.text_el("lighthouse keeper", root=ui.find(".recent")))
    ui.click("Delete “lighthouse keeper", exact=False)
    ui.click("Delete", root=ui.dialog("Delete conversation?", role="alertdialog"))
    ui.toast("Conversation deleted")
    ui.until(lambda: "lighthouse keeper" not in ui.find(".recent").text, "the conversation to disappear")
    ui.until(lambda: len(ui.visible(".mood")) == 8, "the home screen to fade in")


def test_usage_popover_shows_tokens_and_cost(ui):
    ui.ask("cozy mystery in an english village")
    ui.find(ui.tid("usage-button")).click()
    usage = ui.dialog("Usage", exact=True)
    assert "token" in usage.text.lower() and "$" in usage.text
