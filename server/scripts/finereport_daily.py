DAILY_NORTH_TITLE = "第一服务华北地区各服务中心计划预算回款日报"


def is_daily_body_ready(body: str, min_centers: int = 10) -> bool:
    """Only accept a fully rendered North China daily report, never stale data."""
    if len(body) <= 1000 or DAILY_NORTH_TITLE not in body or "累计执行" not in body:
        return False
    center_count = (
        body.count("第一服务")
        + body.count("第一酒店")
        + body.count("华北第一保洁")
    )
    return center_count >= min_centers
