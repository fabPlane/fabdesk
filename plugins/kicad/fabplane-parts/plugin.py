"""KiCad ActionPlugin: search user / team / KiCad libraries and copy a schematic clipboard snippet."""

from __future__ import annotations

import os
import sys

try:
    from .client import STRINGS, DaemonError, PartsPickerClient, connect
except ImportError:
    from client import STRINGS, DaemonError, PartsPickerClient, connect  # type: ignore

# pcbnew / wx are provided by KiCad. Unit tests never import this module.
import pcbnew  # type: ignore
import wx  # type: ignore


DARK_BG = wx.Colour(22, 27, 34)
DARK_PANEL = wx.Colour(30, 36, 44)
DARK_INPUT = wx.Colour(22, 27, 34)
DARK_ROW = wx.Colour(30, 36, 44)
SELECT_BG = wx.Colour(36, 89, 158)
TEXT = wx.Colour(230, 237, 243)
MUTED = wx.Colour(139, 148, 158)
WARN = wx.Colour(227, 179, 65)
ACCENT = wx.Colour(47, 129, 247)
BORDER = wx.Colour(48, 54, 61)


def _paint(widget: wx.Window, bg: wx.Colour, fg: wx.Colour | None = None) -> None:
    widget.SetBackgroundColour(bg)
    if fg is not None:
        widget.SetForegroundColour(fg)


class PartsPickerFrame(wx.Dialog):
    def __init__(self, parent: wx.Window | None, client: PartsPickerClient):
        super().__init__(
            parent,
            title=STRINGS["title"],
            size=wx.Size(920, 560),
            style=wx.DEFAULT_DIALOG_STYLE | wx.RESIZE_BORDER,
        )
        self.client = client
        self.hits: list[dict] = []
        self.selected = -1
        self._org = ""
        self._build()
        self._load_status()

    def _build(self) -> None:
        _paint(self, DARK_BG, TEXT)
        root = wx.BoxSizer(wx.VERTICAL)
        panel = wx.Panel(self)
        _paint(panel, DARK_PANEL, TEXT)
        sizer = wx.BoxSizer(wx.VERTICAL)

        header = wx.BoxSizer(wx.HORIZONTAL)
        title = wx.StaticText(panel, label=STRINGS["title"])
        title.SetFont(wx.Font(14, wx.FONTFAMILY_SWISS, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_BOLD))
        _paint(title, DARK_PANEL, TEXT)
        self.org_label = wx.StaticText(panel, label="")
        _paint(self.org_label, DARK_PANEL, MUTED)
        header.Add(title, 1, wx.ALIGN_CENTER_VERTICAL)
        header.Add(self.org_label, 0, wx.ALIGN_CENTER_VERTICAL)
        sizer.Add(header, 0, wx.EXPAND | wx.ALL, 12)

        self.search = wx.TextCtrl(panel, style=wx.TE_PROCESS_ENTER)
        _paint(self.search, DARK_INPUT, TEXT)
        sizer.Add(self.search, 0, wx.EXPAND | wx.LEFT | wx.RIGHT, 12)

        self.list = wx.ListCtrl(panel, style=wx.LC_REPORT | wx.LC_SINGLE_SEL | wx.LC_HRULES)
        _paint(self.list, DARK_ROW, TEXT)
        for index, label in enumerate(STRINGS["columns"]):
            self.list.InsertColumn(index, label, width=140 if index else 120)
        self.list.SetColumnWidth(1, 160)
        self.list.SetColumnWidth(2, 260)
        sizer.Add(self.list, 1, wx.EXPAND | wx.ALL, 12)

        self.status = wx.StaticText(panel, label=STRINGS["type_query"])
        _paint(self.status, DARK_PANEL, MUTED)
        sizer.Add(self.status, 0, wx.EXPAND | wx.LEFT | wx.RIGHT | wx.BOTTOM, 12)

        self.warn = wx.StaticText(panel, label="")
        _paint(self.warn, DARK_PANEL, WARN)
        sizer.Add(self.warn, 0, wx.EXPAND | wx.LEFT | wx.RIGHT | wx.BOTTOM, 12)

        row = wx.BoxSizer(wx.HORIZONTAL)
        self.make_input = wx.TextCtrl(panel)
        self.make_input.SetHint(STRINGS["make_placeholder"])
        _paint(self.make_input, DARK_INPUT, TEXT)
        self.make_btn = wx.Button(panel, label=STRINGS["make_button"])
        self.copy_btn = wx.Button(panel, label=STRINGS["copy_button"])
        self.copy_btn.SetBackgroundColour(ACCENT)
        self.copy_btn.SetForegroundColour(wx.Colour(255, 255, 255))
        row.Add(self.make_input, 1, wx.RIGHT | wx.ALIGN_CENTER_VERTICAL, 8)
        row.Add(self.make_btn, 0, wx.RIGHT | wx.ALIGN_CENTER_VERTICAL, 8)
        row.Add(self.copy_btn, 0, wx.ALIGN_CENTER_VERTICAL)
        sizer.Add(row, 0, wx.EXPAND | wx.LEFT | wx.RIGHT | wx.BOTTOM, 12)

        panel.SetSizer(sizer)
        root.Add(panel, 1, wx.EXPAND)
        self.SetSizer(root)

        self.search.Bind(wx.EVT_TEXT_ENTER, lambda _e: self._search())
        self.search.Bind(wx.EVT_TEXT, lambda _e: self._on_query())
        self.list.Bind(wx.EVT_LIST_ITEM_SELECTED, self._on_select)
        self.list.Bind(wx.EVT_LIST_ITEM_ACTIVATED, lambda _e: self._copy())
        self.make_btn.Bind(wx.EVT_BUTTON, lambda _e: self._make())
        self.copy_btn.Bind(wx.EVT_BUTTON, lambda _e: self._copy())
        self._timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, lambda _e: self._search(), self._timer)

    def _on_query(self) -> None:
        self._timer.StartOnce(180)

    def _load_status(self) -> None:
        try:
            status = self.client.status()
        except DaemonError as error:
            if error.status in (401, 403) or error.code == "cloud_signed_out":
                wx.MessageBox(STRINGS["sign_in"], STRINGS["title"], wx.OK | wx.ICON_INFORMATION)
                self.EndModal(wx.ID_CANCEL)
                return
            wx.MessageBox(str(error), STRINGS["title"], wx.OK | wx.ICON_ERROR)
            self.EndModal(wx.ID_CANCEL)
            return
        org = status.get("orgName") or ""
        self._org = org
        self.org_label.SetLabel(f"{org} · {STRINGS['signed_in']}" if org else STRINGS["signed_in"])
        self.Layout()

    def _search(self) -> None:
        query = self.search.GetValue().strip()
        if not self.make_input.GetValue().strip():
            self.make_input.SetValue(query)
        try:
            result = self.client.search(query)
        except DaemonError as error:
            self.status.SetLabel(str(error))
            return
        self.hits = list(result.get("hits") or [])
        self.selected = 0 if self.hits else -1
        self.list.DeleteAllItems()
        for hit in self.hits:
            index = self.list.InsertItem(self.list.GetItemCount(), str(hit.get("sourceLabel") or hit.get("source") or ""))
            self.list.SetItem(index, 1, str(hit.get("symbol") or ""))
            self.list.SetItem(index, 2, str(hit.get("footprint") or ""))
            self.list.SetItem(index, 3, str(hit.get("value") or ""))
            self.list.SetItem(index, 4, str(hit.get("mpn") or ""))
            self.list.SetItem(index, 5, str(hit.get("manufacturer") or ""))
        if self.hits:
            self.list.SetItemState(0, wx.LIST_STATE_SELECTED, wx.LIST_STATE_SELECTED)
        make = bool(result.get("makeThisPart"))
        self.warn.SetLabel(STRINGS["empty_prompt"] if make else "")
        self.status.SetLabel(str(result.get("message") or ""))
        self.copy_btn.Show(bool(self.hits))
        self.make_btn.SetBackgroundColour(ACCENT if make or not self.hits else BORDER)
        self.make_btn.SetForegroundColour(wx.Colour(255, 255, 255) if make or not self.hits else TEXT)
        self.Layout()

    def _on_select(self, event: wx.ListEvent) -> None:
        self.selected = event.GetIndex()

    def _selected_hit(self) -> dict | None:
        if 0 <= self.selected < len(self.hits):
            return self.hits[self.selected]
        return None

    def _copy_text(self, text: str) -> None:
        if wx.TheClipboard.Open():
            wx.TheClipboard.SetData(wx.TextDataObject(text))
            wx.TheClipboard.Flush()
            wx.TheClipboard.Close()
        preview = wx.Dialog(self, title=STRINGS["clipboard_title"], size=wx.Size(720, 420))
        _paint(preview, DARK_BG, TEXT)
        box = wx.BoxSizer(wx.VERTICAL)
        hint = wx.StaticText(preview, label=STRINGS["clipboard_hint"])
        _paint(hint, DARK_BG, MUTED)
        body = wx.TextCtrl(preview, value=text, style=wx.TE_MULTILINE | wx.TE_READONLY | wx.TE_DONTWRAP)
        _paint(body, DARK_INPUT, TEXT)
        font = wx.Font(10, wx.FONTFAMILY_TELETYPE, wx.FONTSTYLE_NORMAL, wx.FONTWEIGHT_NORMAL)
        body.SetFont(font)
        box.Add(hint, 0, wx.ALL, 12)
        box.Add(body, 1, wx.EXPAND | wx.LEFT | wx.RIGHT | wx.BOTTOM, 12)
        preview.SetSizer(box)
        preview.ShowModal()
        preview.Destroy()

    def _copy(self) -> None:
        hit = self._selected_hit()
        if not hit:
            return
        try:
            result = self.client.paste(hit)
        except DaemonError as error:
            wx.MessageBox(str(error), STRINGS["title"], wx.OK | wx.ICON_ERROR)
            return
        paste = result.get("paste") or ""
        self._copy_text(paste)

    def _make(self) -> None:
        text = self.make_input.GetValue().strip() or self.search.GetValue().strip()
        if not text:
            self.warn.SetLabel(STRINGS["empty_prompt"])
            return
        try:
            result = self.client.make(text)
        except DaemonError as error:
            wx.MessageBox(str(error), STRINGS["title"], wx.OK | wx.ICON_ERROR)
            return
        paste = result.get("paste") or ""
        self._copy_text(paste)


class FabplanePartsPlugin(pcbnew.ActionPlugin):
    def defaults(self) -> None:
        self.name = STRINGS["title"]
        self.category = "fabPlane"
        self.description = "Search shared parts and copy a self-contained schematic clipboard snippet."
        self.show_toolbar_button = True
        icon = os.path.join(os.path.dirname(__file__), "icon.png")
        if os.path.isfile(icon):
            self.icon_file_name = icon

    def Run(self) -> None:
        try:
            client = connect()
        except FileNotFoundError as error:
            wx.MessageBox(str(error), STRINGS["title"], wx.OK | wx.ICON_INFORMATION)
            return
        except Exception as error:  # noqa: BLE001 — show whatever blocked the handshake
            wx.MessageBox(str(error), STRINGS["title"], wx.OK | wx.ICON_ERROR)
            return
        parent = wx.FindWindowByName("PcbFrame") or wx.FindWindowByName("SchematicFrame")
        dialog = PartsPickerFrame(parent, client)
        dialog.ShowModal()
        dialog.Destroy()


def register() -> None:
    FabplanePartsPlugin().register()


if __name__ == "__main__":
    # Allow `python plugin.py` from inside KiCad's console after pcbnew is on sys.path.
    if "pcbnew" not in sys.modules:
        raise SystemExit("Run this from KiCad (Tools → External Plugins).")
    register()
