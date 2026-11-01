# Example list files

CSV files for the **import** buttons in the sidebar, matched to `mouse_ileum_tiny` and `cosmx-mousebrain`.

| File | Sidebar section | What it does |
|---|---|---|
| `mouse_ileum_genes.csv` | Transcript species | Shows only these 8 marker genes |
| `mouse_ileum_lrms.csv` | LRM Mechanisms | Keeps only these 5 mechanisms active |
| `mouse_brain_neuropeptides.csv` | LRM Mechanisms | `cosmx-mousebrain`: 31 neuropeptide → receptor mechanisms (worked example 6) |
| `mouse_brain_glial_support.csv` | LRM Mechanisms | `cosmx-mousebrain`: 22 glial lipid-transport, complement and microglial mechanisms (worked example 6) |

`mouse_ileum_genes.csv` is in Xenium Explorer's gene-group format (`gene,group`),
to show that such a file imports unchanged. TissuePlex ignores the `group` column.
`mouse_ileum_lrms.csv` uses the two-column `ligand,receptor` form. The other
accepted form is a single `lrm` column holding `ligand|receptor`, which is what
the **export** button writes.

These lists live in their own folder on purpose. A CSV in a dataset's root
folder is loaded as supplemental **cell metadata**, so a gene list placed
there would be joined into the cells table.
