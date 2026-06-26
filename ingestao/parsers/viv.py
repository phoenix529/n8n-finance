# -*- coding: utf-8 -*-
"""Parser Viv (eventos/mostruário; dados desde 2021)."""
from .base import parse_dre_base
def parse_viv(caminho, year=2026):
    return parse_dre_base(caminho, "VIV", year)
