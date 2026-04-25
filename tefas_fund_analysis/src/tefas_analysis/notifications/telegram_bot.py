from __future__ import annotations

from typing import Optional

import requests

from tefas_analysis.config import NotificationConfig


class TelegramNotifier:
    """Optional Telegram notification sender."""

    def __init__(
        self,
        config: NotificationConfig,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.config = config
        self.session = session or requests.Session()

    @property
    def is_configured(self) -> bool:
        return bool(
            self.config.telegram_enabled
            and self.config.telegram_bot_token
            and self.config.telegram_chat_id
        )

    def send_message(self, message: str) -> None:
        if not self.is_configured:
            return

        url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"
        response = self.session.post(
            url,
            json={
                "chat_id": self.config.telegram_chat_id,
                "text": message[:3900],
                "disable_web_page_preview": True,
            },
            timeout=15,
        )
        response.raise_for_status()
