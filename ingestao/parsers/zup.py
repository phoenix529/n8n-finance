# -*- coding: utf-8 -*-
"""Parser Zup (tech/fees; somente 2025-2026; 2026 com custos ainda não lançados)."""
from .base import parse_dre_base
def parse_zup(caminho, year=2026):
    return parse_dre_base(caminho, "ZUP", year)
