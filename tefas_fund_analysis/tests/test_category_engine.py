from tefas_analysis.analysis.category_engine import CategoryEngine, FundCategory


def test_category_engine_classifies_money_market_title():
    assert (
        CategoryEngine().classify("ABC Para Piyasası Fonu")
        == FundCategory.MONEY_MARKET
    )


def test_category_engine_classifies_equity_title():
    assert (
        CategoryEngine().classify("XYZ Hisse Senedi Fonu")
        == FundCategory.EQUITY
    )


def test_category_engine_classifies_variable_title():
    assert (
        CategoryEngine().classify("XYZ Değişken Fon")
        == FundCategory.VARIABLE
    )


def test_category_engine_classifies_precious_metals_title():
    assert (
        CategoryEngine().classify("XYZ Altın Katılım Fonu")
        == FundCategory.PRECIOUS_METALS
    )


def test_category_engine_returns_unknown_for_missing_or_unrecognized_title():
    engine = CategoryEngine()

    assert engine.classify(None) == FundCategory.UNKNOWN
    assert engine.classify("Strateji Serbest Fon") == FundCategory.UNKNOWN
