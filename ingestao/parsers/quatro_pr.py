# -*- coding: utf-8 -*-
"""Parser 4PR (agência; dados desde 2018)."""
from .base import parse_dre_base
def parse_4pr(caminho, year=2026):
    return parse_dre_base(caminho, "4PR", year)
