import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { MoyasarProviderService } from "./service"

export { MoyasarProviderService } from "./service"
export { MoyasarApiError, MoyasarClient, MoyasarNetworkError } from "./client"
export { fromMinorUnits, toMinorUnits } from "./currency"
export type * from "./types"

export default ModuleProvider(Modules.PAYMENT, {
  services: [MoyasarProviderService],
})
