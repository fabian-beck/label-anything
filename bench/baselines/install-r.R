# CRAN install of the ggrepel baseline's R packages at the pinned versions (bench/baselines/install-r.sh
# --cran). Already installed packages at the pinned version are kept. Repository: $CRAN_REPO or
# https://cloud.r-project.org (archived versions are fetched by remotes::install_version).
pins <- c(jsonlite = "1.8.8", ggplot2 = "3.4.4", ggrepel = "0.9.5")
repos <- Sys.getenv("CRAN_REPO", "https://cloud.r-project.org")
if (!requireNamespace("remotes", quietly = TRUE)) {
  install.packages("remotes", repos = repos)
}
for (p in names(pins)) {
  have <- if (requireNamespace(p, quietly = TRUE)) as.character(packageVersion(p)) else ""
  if (!identical(have, pins[[p]])) {
    remotes::install_version(p, version = pins[[p]], repos = repos, upgrade = "never", quiet = TRUE)
  }
}
for (p in names(pins)) {
  v <- as.character(packageVersion(p))
  if (!identical(v, pins[[p]])) stop(sprintf("%s %s installed, %s pinned", p, v, pins[[p]]))
}
