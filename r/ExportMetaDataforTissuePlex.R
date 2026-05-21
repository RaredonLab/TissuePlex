# Export metadata for TissuePlex
require(Seurat)
library(data.table)

#load
load("~/Large Files/Pneumonectomy_Project_transfer/MSBR_polishing_2025-11-01/outputs/PPLR.polished.with.territory.and.neighborhood.2025-11-17.Robj")

#update
PPLR.polished <- UpdateSeuratObject(PPLR.polished)

#isolate
PPLR.meta.data <- PPLR.polished@meta.data

# write to docker testing file
fwrite(PPLR.meta.data, 
       file = "/Users/msbr/Large Files/Xenium/for-docker-testing/RQ32878-002_Slide_2_PPLR_726-2/Rat-PPLR-Run1/PPLR.meta.data.csv",
       row.names = T)
