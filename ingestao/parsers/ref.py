# -*- coding: utf-8 -*-
"""Parser REF Comunicação (empresa principal; possui aba de receita por cliente)."""
from .base import parse_dre_base
def parse_ref(caminho, year=2026):
    return parse_dre_base(caminho, "REF", year)
