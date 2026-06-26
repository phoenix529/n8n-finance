# -*- coding: utf-8 -*-
"""Parser BD (produtora). Usa 'PRODUTORA' no lugar de 'AGÊNCIA' — tratado na base."""
from .base import parse_dre_base
def parse_bd(caminho, year=2026):
    return parse_dre_base(caminho, "BD", year)
