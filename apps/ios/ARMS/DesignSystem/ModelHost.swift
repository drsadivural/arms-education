import SwiftUI

/// Creates a screen's view model once (when the view first appears) and keeps it for the view's
/// lifetime. Lets the factory use values from the SwiftUI environment.
struct ModelHost<Model: AnyObject, Content: View>: View {
  let make: () -> Model
  @ViewBuilder let content: (Model) -> Content
  @State private var model: Model?

  var body: some View {
    if let model {
      content(model)
    } else {
      Color.clear
        .armsScreen()
        .onAppear { if model == nil { model = make() } }
    }
  }
}
