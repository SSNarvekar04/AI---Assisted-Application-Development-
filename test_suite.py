"""Comprehensive test suite for AI-Powered Student Virtual Assistant.

Covers:
1. Core Assistant logic (validation, demo mode routing, config, error handling, message trimming)
2. Streamlit UI behavior via AppTest (initial layout, buttons, forms, warnings, clear, live mode, error display)
3. Live Streamlit server HTTP health smoke test
"""

import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch, MagicMock

import requests
from streamlit.testing.v1 import AppTest

import assistant as bot
import run_tests


class TestAssistantValidation(unittest.TestCase):
    """Test input validation and boundary conditions in assistant.py."""

    def test_empty_messages_list(self):
        with self.assertRaises(bot.AssistantError) as ctx:
            bot.generate_reply([])
        self.assertIn("Nothing to answer", str(ctx.exception))

    def test_last_message_not_user(self):
        with self.assertRaises(bot.AssistantError) as ctx:
            bot.generate_reply([{"role": "assistant", "content": "Hi"}])
        self.assertIn("Nothing to answer", str(ctx.exception))

    def test_empty_question(self):
        with self.assertRaises(bot.AssistantError) as ctx:
            bot.generate_reply([{"role": "user", "content": ""}])
        self.assertIn("Please type a question first", str(ctx.exception))

    def test_whitespace_only_question(self):
        with self.assertRaises(bot.AssistantError) as ctx:
            bot.generate_reply([{"role": "user", "content": "   \n\t  "}])
        self.assertIn("Please type a question first", str(ctx.exception))

    def test_question_too_long(self):
        with self.assertRaises(bot.AssistantError) as ctx:
            bot.generate_reply([{"role": "user", "content": "a" * (bot.MAX_INPUT_CHARS + 1)}])
        self.assertIn("too long", str(ctx.exception))

    def test_question_exactly_at_limit(self):
        # Exactly MAX_INPUT_CHARS should not raise validation error
        msg = "a" * bot.MAX_INPUT_CHARS
        reply = bot.generate_reply([{"role": "user", "content": msg}])
        self.assertIsInstance(reply, bot.Reply)


class TestAssistantDemoMode(unittest.TestCase):
    """Test demo mode response routing and content."""

    def setUp(self):
        self.patcher = patch.object(bot, "is_live", return_value=False)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()

    def test_machine_learning_routing(self):
        reply = bot.generate_reply([{"role": "user", "content": "Explain machine learning in simple terms."}])
        self.assertEqual(reply.mode, "demo")
        self.assertIn(bot.DEMO_LABEL, reply.text)
        self.assertIn("Machine learning in simple terms", reply.text)
        self.assertIn("learn patterns from examples", reply.text)

    def test_sync_async_js_routing(self):
        reply = bot.generate_reply([{"role": "user", "content": "Explain synchronous vs asynchronous JavaScript."}])
        self.assertEqual(reply.mode, "demo")
        self.assertIn(bot.DEMO_LABEL, reply.text)
        self.assertIn("Synchronous vs asynchronous JavaScript", reply.text)
        self.assertIn("```javascript", reply.text)

    def test_study_plan_routing(self):
        reply = bot.generate_reply([{"role": "user", "content": "Give me a simple 5-step plan to revise for exams."}])
        self.assertEqual(reply.mode, "demo")
        self.assertIn(bot.DEMO_LABEL, reply.text)
        self.assertIn("A simple 5-step revision plan", reply.text)

    def test_vague_input_without_history(self):
        reply = bot.generate_reply([{"role": "user", "content": "Explain it."}])
        self.assertEqual(reply.mode, "demo")
        self.assertIn("Which topic or concept would you like me to explain?", reply.text)
        self.assertIn("Your message says \"it\"", reply.text)

    def test_vague_patterns(self):
        for phrase in ["explain this", "help with that", "describe them.", "fix it"]:
            reply = bot.generate_reply([{"role": "user", "content": phrase}])
            self.assertIn("Which topic or concept would you like me to explain?", reply.text, f"Failed on {phrase}")

    def test_vague_input_with_prior_history(self):
        history = [
            {"role": "user", "content": "Explain machine learning in simple terms."},
            {"role": "assistant", "content": "Machine learning is..."},
            {"role": "user", "content": "Explain it."},
        ]
        reply = bot.generate_reply(history)
        # Because history exists, it should not trigger the vague clarification
        self.assertNotIn("Which topic or concept would you like me to explain?", reply.text)

    def test_fallback_routing(self):
        reply = bot.generate_reply([{"role": "user", "content": "What is the capital of France?"}])
        self.assertEqual(reply.mode, "demo")
        self.assertIn("demo mode", reply.text.lower())
        self.assertIn("only have a few pre-written sample answers", reply.text)


class TestAssistantConfiguration(unittest.TestCase):
    """Test API key and model configuration."""

    def test_get_api_key_valid(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-1234567890"}):
            self.assertEqual(bot.get_api_key(), "sk-ant-1234567890")
            self.assertTrue(bot.is_live())

    def test_get_api_key_empty(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
            self.assertIsNone(bot.get_api_key())
            self.assertFalse(bot.is_live())

    def test_get_api_key_placeholder(self):
        for placeholder in ["your_api_key_here", "YOUR_KEY", "...", "   "]:
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": placeholder}):
                self.assertIsNone(bot.get_api_key())
                self.assertFalse(bot.is_live())

    def test_get_model_default(self):
        with patch.dict(os.environ, {"ANTHROPIC_MODEL": ""}):
            self.assertEqual(bot.get_model(), bot.DEFAULT_MODEL)

    def test_get_model_custom(self):
        with patch.dict(os.environ, {"ANTHROPIC_MODEL": "claude-3-opus-20240229"}):
            self.assertEqual(bot.get_model(), "claude-3-opus-20240229")


class TestAssistantErrorHandling(unittest.TestCase):
    """Test error translation and security (no key leakage)."""

    def test_authentication_error(self):
        class AuthenticationError(Exception):
            status_code = 401

        msg = bot._friendly_error(AuthenticationError("API key sk-ant-secret invalid"))
        self.assertIn("API key was rejected", msg)
        self.assertNotIn("sk-ant-secret", msg)

    def test_rate_limit_error(self):
        class RateLimitError(Exception):
            status_code = 429

        msg = bot._friendly_error(RateLimitError("Quota exceeded sk-ant-secret"))
        self.assertIn("Too many requests", msg)
        self.assertNotIn("sk-ant-secret", msg)

    def test_connection_error(self):
        class APIConnectionError(Exception):
            pass

        msg = bot._friendly_error(APIConnectionError("Failed to connect"))
        self.assertIn("Could not reach the AI service", msg)

    def test_model_not_found_error(self):
        class NotFoundError(Exception):
            status_code = 404

        msg = bot._friendly_error(NotFoundError("Model not found"))
        self.assertIn("configured model was not found", msg)

    def test_internal_server_error(self):
        class InternalServerError(Exception):
            status_code = 500

        msg = bot._friendly_error(InternalServerError("Server error"))
        self.assertIn("having problems right now", msg)

    def test_bad_request_error(self):
        class BadRequestError(Exception):
            status_code = 400

        msg = bot._friendly_error(BadRequestError("Bad request"))
        self.assertIn("request was rejected", msg)

    def test_generic_fallback_error(self):
        msg = bot._friendly_error(RuntimeError("Unknown problem"))
        self.assertIn("Something went wrong", msg)


class TestAssistantCallClaude(unittest.TestCase):
    """Test _call_claude message trimming and client handling."""

    @patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test"})
    @patch("anthropic.Anthropic")
    def test_call_claude_history_trimming(self, mock_anthropic_class):
        # Create 25 messages, ensuring trimming to MAX_HISTORY_MESSAGES
        messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"} for i in range(25)]
        mock_client = MagicMock()
        mock_anthropic_class.return_value = mock_client
        mock_response = MagicMock()
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "AI response text"
        mock_response.content = [text_block]
        mock_client.messages.create.return_value = mock_response

        reply = bot._call_claude(messages)
        self.assertEqual(reply, "AI response text")

        call_args = mock_client.messages.create.call_args[1]
        trimmed = call_args["messages"]
        self.assertLessEqual(len(trimmed), bot.MAX_HISTORY_MESSAGES)
        self.assertEqual(trimmed[0]["role"], "user")

    @patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test"})
    @patch("anthropic.Anthropic")
    def test_call_claude_empty_response(self, mock_anthropic_class):
        mock_client = MagicMock()
        mock_anthropic_class.return_value = mock_client
        mock_response = MagicMock()
        mock_response.content = []
        mock_client.messages.create.return_value = mock_response

        with self.assertRaises(bot.AssistantError) as ctx:
            bot._call_claude([{"role": "user", "content": "hello"}])
        self.assertIn("empty response", str(ctx.exception))


class TestStreamlitUI(unittest.TestCase):
    """Test Streamlit UI interactions via AppTest."""

    def test_initial_render_demo_mode(self):
        at = AppTest.from_file("app.py")
        at.run()
        self.assertFalse(at.exception)
        self.assertIn("Student Virtual Assistant", at.title[0].value)
        self.assertEqual(len(at.button), 5)  # 3 examples + Send + Clear
        # Sidebar warning in demo mode
        self.assertTrue(any("DEMO MODE" in w.value for w in at.sidebar.warning))

    def test_clicking_example_1(self):
        at = AppTest.from_file("app.py")
        at.run()
        at.button[0].click().run()
        self.assertFalse(at.exception)
        self.assertEqual(len(at.chat_message), 2)
        self.assertEqual(at.chat_message[0].name, "user")
        self.assertEqual(at.chat_message[0].markdown[0].value, bot.EXAMPLE_QUESTIONS[0])
        self.assertEqual(at.chat_message[1].name, "assistant")
        self.assertIn("Machine learning in simple terms", at.chat_message[1].markdown[0].value)
        self.assertIn("Demo response", at.chat_message[1].caption[0].value)

    def test_clicking_example_2(self):
        at = AppTest.from_file("app.py")
        at.run()
        at.button[1].click().run()
        self.assertFalse(at.exception)
        self.assertEqual(len(at.chat_message), 2)
        self.assertIn("Synchronous vs asynchronous JavaScript", at.chat_message[1].markdown[0].value)

    def test_clicking_example_3(self):
        at = AppTest.from_file("app.py")
        at.run()
        at.button[2].click().run()
        self.assertFalse(at.exception)
        self.assertEqual(len(at.chat_message), 2)
        self.assertIn("A simple 5-step revision plan", at.chat_message[1].markdown[0].value)

    def test_empty_input_submission_warning(self):
        at = AppTest.from_file("app.py")
        at.run()
        # Click send without input
        at.button[3].click().run()
        self.assertFalse(at.exception)
        self.assertTrue(any("Please type a question before pressing Send" in w.value for w in at.warning))

    def test_custom_question_submission(self):
        at = AppTest.from_file("app.py")
        at.run()
        at.text_input[0].input("Explain it.")
        at.button[3].click().run()
        self.assertFalse(at.exception)
        self.assertEqual(len(at.chat_message), 2)
        self.assertEqual(at.chat_message[0].markdown[0].value, "Explain it.")
        self.assertIn("Which topic or concept would you like me to explain?", at.chat_message[1].markdown[0].value)

    def test_clear_conversation(self):
        at = AppTest.from_file("app.py")
        at.run()
        at.button[0].click().run()
        self.assertEqual(len(at.session_state.messages), 2)
        at.button[4].click().run()
        self.assertEqual(len(at.session_state.messages), 0)
        self.assertEqual(len(at.chat_message), 0)

    def test_ui_simulated_live_mode(self):
        with patch.object(bot, "is_live", return_value=True), \
             patch.object(bot, "_call_claude", return_value="Live response for student"):
            at = AppTest.from_file("app.py")
            at.run()
            self.assertFalse(at.exception)
            self.assertTrue(any("Live AI mode" in s.value for s in at.sidebar.success))
            at.button[0].click().run()
            self.assertEqual(at.chat_message[1].markdown[0].value, "Live response for student")
            # In live mode there should be no demo caption
            self.assertEqual(len(at.chat_message[1].caption), 0)

    def test_ui_handles_assistant_error_gracefully(self):
        with patch.object(bot, "is_live", return_value=True), \
             patch.object(bot, "_call_claude", side_effect=bot.AssistantError("Simulated rejection")):
            at = AppTest.from_file("app.py")
            at.run()
            at.button[0].click().run()
            self.assertFalse(at.exception)
            self.assertEqual(at.chat_message[1].error[0].value, "Simulated rejection")

    def test_ui_handles_unexpected_error_gracefully(self):
        with patch.object(bot, "generate_reply", side_effect=Exception("Critical system error")):
            at = AppTest.from_file("app.py")
            at.run()
            at.button[0].click().run()
            self.assertFalse(at.exception)
            self.assertIn("Unexpected error", at.chat_message[1].error[0].value)


class TestLiveStreamlitServer(unittest.TestCase):
    """Test actual Streamlit server execution and HTTP endpoints."""

    def test_server_startup_and_health_endpoint(self):
        proc = subprocess.Popen(
            [sys.executable, "-m", "streamlit", "run", "app.py", "--server.headless=true", "--server.port=8502"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        started = False
        health_status = None
        home_status = None
        try:
            for _ in range(25):
                time.sleep(1)
                try:
                    r_health = requests.get("http://localhost:8502/_stcore/health", timeout=1)
                    if r_health.status_code == 200:
                        started = True
                        health_status = r_health.status_code
                        r_home = requests.get("http://localhost:8502/", timeout=2)
                        home_status = r_home.status_code
                        break
                except Exception:
                    pass
        finally:
            proc.terminate()
            proc.wait(timeout=5)

        self.assertTrue(started, "Streamlit server did not become healthy within timeout.")
        self.assertEqual(health_status, 200)
        self.assertEqual(home_status, 200)


if __name__ == "__main__":
    unittest.main()
